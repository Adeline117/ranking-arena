import type { AuthorizedConsumedRegionContext } from '../consumed-region-context'
import {
  prepareRegionConsumerRuntime,
  type RegionConsumer,
  type RegionConsumerRuntimeError,
} from '../region-consumer-runtime'
import {
  acquireRegionAuthorityLifecycle,
  type RegionAuthorityLifecycle,
} from '../region-authority-lifecycle'
import type { WorkerDbFence, WorkerDbFenceProof } from '../worker-db-fence'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function proof(): WorkerDbFenceProof {
  return {
    authorityScope: 'region:local',
    controlEpoch: 1,
    controlServerTimeMs: 1_000,
    databaseEpoch: 1,
    databaseLeaseExpiresAt: '2026-07-28T20:03:00.000Z',
    databaseServerTime: '2026-07-28T20:00:00.000Z',
    initialControlServerTimeMs: 1_000,
    instanceId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'region-consumer-runtime-test',
    region: 'local',
  }
}

async function lifecycleHarness(events: string[]): Promise<{
  abort: (reason?: Error) => void
  lifecycle: RegionAuthorityLifecycle
  release: jest.Mock
}> {
  const controller = new AbortController()
  let fenceState: WorkerDbFence['state'] = 'active'
  const release = jest.fn(async () => {
    events.push('authority:release')
    fenceState = 'released'
    controller.abort(new Error('intentional release'))
  })
  const fence: WorkerDbFence = {
    proof: proof(),
    signal: controller.signal,
    get state() {
      return fenceState
    },
    isActive: () => fenceState === 'active' && !controller.signal.aborted,
    release,
    renewAndPublish: jest.fn(async () => undefined),
    withFencedWrite: jest.fn(),
  }
  const result = await acquireRegionAuthorityLifecycle({
    acquireAuthority: async () => ({ fence, status: 'active' }),
    heartbeat: () => ({
      attempt_bound_capture: true,
      node: 'region-consumer-runtime-test',
      pid: 42,
      regions: ['local'],
      release_id: 'a'.repeat(64),
      sha: 'b'.repeat(40),
    }),
    onLost: jest.fn(),
    redis: { eval: jest.fn() },
    region: 'local',
    scheduleRenewal: () => ({ cancel: jest.fn(), unref: jest.fn() }),
  })
  if (result.status !== 'active') throw new Error('expected active lifecycle')
  return {
    abort: (reason = new Error('authority lost')) => {
      fenceState = 'fenced'
      controller.abort(reason)
    },
    lifecycle: result.lifecycle,
    release,
  }
}

function consumerHarness(
  name: string,
  events: string[],
  run = deferred<void>()
): RegionConsumer & {
  emitError(error?: Error): void
  runTask: ReturnType<typeof deferred<void>>
} {
  let errorListener: ((error: Error) => void) | undefined
  let running = false
  const consumer: RegionConsumer & {
    emitError(error?: Error): void
    runTask: ReturnType<typeof deferred<void>>
  } = {
    cancelAllJobs: jest.fn((reason?: string) => events.push(`${name}:cancel:${reason}`)),
    close: jest.fn(async (force?: boolean) => {
      events.push(`${name}:close:${String(force)}`)
      running = false
      run.resolve()
    }),
    emitError: (error = new Error('consumer error')) => errorListener?.(error),
    isRunning: jest.fn(() => running),
    on: jest.fn((_event: 'error', listener: (error: Error) => void) => {
      errorListener = listener
    }),
    pause: jest.fn(async (doNotWaitActive?: boolean) => {
      events.push(`${name}:pause:${String(doNotWaitActive)}`)
    }),
    run: jest.fn(() => {
      events.push(`${name}:run`)
      running = true
      return run.promise
    }),
    runTask: run,
    waitUntilReady: jest.fn(async () => {
      events.push(`${name}:ready`)
    }),
  }
  return consumer
}

type Registrar = <TConsumer extends RegionConsumer>(consumer: TConsumer) => TConsumer

async function prepareHarness(
  events: string[],
  configure: (register: Registrar) => Promise<void> | void,
  onUnexpectedStop = jest.fn()
) {
  const authority = await lifecycleHarness(events)
  let context!: AuthorizedConsumedRegionContext
  const runtime = await prepareRegionConsumerRuntime({
    createConsumers: (authorizedContext, register) => {
      context = authorizedContext
      return configure(register)
    },
    executionRegion: 'local',
    lifecycle: authority.lifecycle,
    onUnexpectedStop,
  })
  return { ...authority, context, onUnexpectedStop, runtime }
}

describe('regional consumer runtime', () => {
  it('prepares every consumer without running or opening admission', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    const { context, runtime } = await prepareHarness(events, (register) => {
      register(first)
      register(second)
    })

    expect(runtime.state).toBe('prepared')
    expect(events).toEqual(['first:ready', 'second:ready'])
    expect(first.run).not.toHaveBeenCalled()
    expect(second.run).not.toHaveBeenCalled()
    expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')

    await runtime.stop('signal')
  })

  it('starts every run loop before opening the real authority admission', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    const { context, runtime } = await prepareHarness(events, (register) => {
      register(first)
      register(second)
    })
    events.length = 0

    await runtime.start()

    expect(runtime.state).toBe('running')
    expect(events).toEqual(['first:run', 'second:run'])
    expect(() => context.assertCanConsume()).not.toThrow()
    await runtime.stop('signal')
  })

  it('rejects an accidentally autorun consumer and waits for a graceful close', async () => {
    const events: string[] = []
    const authority = await lifecycleHarness(events)
    const consumer = consumerHarness('autorun', events)
    ;(consumer.isRunning as jest.Mock).mockReturnValue(true)

    await expect(
      prepareRegionConsumerRuntime({
        createConsumers: (_context, register) => {
          register(consumer)
        },
        executionRegion: 'local',
        lifecycle: authority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'prepare_failed' })

    expect(consumer.pause).toHaveBeenCalledWith(true)
    expect(consumer.close).toHaveBeenCalledWith(false)
    expect(authority.release).toHaveBeenCalledTimes(1)
  })

  it.each(['rejected', 'resolved'] as const)(
    'never opens admission when a run loop is immediately %s',
    async (outcome) => {
      const events: string[] = []
      const consumer = consumerHarness('consumer', events)
      ;(consumer.run as jest.Mock).mockImplementationOnce(() => {
        events.push('consumer:run')
        return outcome === 'rejected'
          ? Promise.reject(new Error('secret immediate run failure'))
          : Promise.resolve()
      })
      const { context, release, runtime } = await prepareHarness(events, (register) => {
        register(consumer)
      })

      await expect(runtime.start()).rejects.toMatchObject({
        code: outcome === 'rejected' ? 'run_failed' : 'stopped_unexpectedly',
      })
      expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')
      expect(release).toHaveBeenCalledTimes(1)
    }
  )

  it('rolls back already-armed loops when a later run call throws synchronously', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    ;(second.run as jest.Mock).mockImplementationOnce(() => {
      events.push('second:run')
      throw new Error('secret synchronous run failure')
    })
    const { context, release, runtime } = await prepareHarness(events, (register) => {
      register(first)
      register(second)
    })
    events.length = 0

    await expect(runtime.start()).rejects.toMatchObject({ code: 'start_failed' })

    expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')
    expect(first.close).toHaveBeenCalledWith(false)
    expect(second.close).toHaveBeenCalledWith(false)
    expect(release).toHaveBeenCalledTimes(1)
    expect(events.at(-1)).toBe('authority:release')
  })

  it('rolls back registered consumers in reverse order before releasing authority', async () => {
    const events: string[] = []
    const authority = await lifecycleHarness(events)
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)

    await expect(
      prepareRegionConsumerRuntime({
        createConsumers: (_context, register) => {
          register(first)
          register(second)
          throw new Error('secret factory failure')
        },
        executionRegion: 'local',
        lifecycle: authority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'prepare_failed' })

    expect(events).toEqual([
      'first:cancel:regional consumer startup aborted',
      'second:cancel:regional consumer startup aborted',
      'second:close:true',
      'first:close:true',
      'authority:release',
    ])
    expect(first.waitUntilReady).not.toHaveBeenCalled()
  })

  it('rejects an asynchronous consumer factory instead of awaiting an unbounded setup', async () => {
    const events: string[] = []
    const authority = await lifecycleHarness(events)
    const consumer = consumerHarness('consumer', events)
    const lateConsumer = consumerHarness('late', events)
    const factoryFinished = deferred<void>()

    await expect(
      prepareRegionConsumerRuntime({
        createConsumers: async (_context, register) => {
          register(consumer)
          await Promise.resolve()
          try {
            register(lateConsumer)
            throw new Error('secret late factory failure')
          } finally {
            factoryFinished.resolve()
          }
        },
        executionRegion: 'local',
        lifecycle: authority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'prepare_failed' })
    await factoryFinished.promise

    expect(consumer.waitUntilReady).not.toHaveBeenCalled()
    expect(consumer.close).toHaveBeenCalledWith(true)
    expect(lateConsumer.close).not.toHaveBeenCalled()
    expect(authority.release).toHaveBeenCalledTimes(1)
  })

  it('rolls back the full set when readiness fails without leaking its cause', async () => {
    const events: string[] = []
    const authority = await lifecycleHarness(events)
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    ;(second.waitUntilReady as jest.Mock).mockRejectedValueOnce(
      new Error('rediss://user:secret@example.invalid')
    )

    let failure: unknown
    try {
      await prepareRegionConsumerRuntime({
        createConsumers: (_context, register) => {
          register(first)
          register(second)
        },
        executionRegion: 'local',
        lifecycle: authority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'prepare_failed' })
    expect(String(failure)).not.toContain('rediss://')
    expect(String(failure)).not.toContain('secret')
    expect(first.close).toHaveBeenCalledWith(true)
    expect(second.close).toHaveBeenCalledWith(true)
    expect(authority.release).toHaveBeenCalledTimes(1)
  })

  it('abandons readiness and rolls back immediately when authority aborts', async () => {
    const events: string[] = []
    const authority = await lifecycleHarness(events)
    const ready = deferred<unknown>()
    const consumer = consumerHarness('consumer', events)
    ;(consumer.waitUntilReady as jest.Mock).mockReturnValueOnce(ready.promise)
    let context!: AuthorizedConsumedRegionContext
    const preparing = prepareRegionConsumerRuntime({
      createConsumers: (authorizedContext, register) => {
        context = authorizedContext
        register(consumer)
      },
      executionRegion: 'local',
      lifecycle: authority.lifecycle,
      onUnexpectedStop: jest.fn(),
    })
    await Promise.resolve()

    authority.abort()

    expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')
    await expect(preparing).rejects.toMatchObject({ code: 'prepare_failed' })
    expect(consumer.close).toHaveBeenCalledWith(true)
    expect(authority.release).toHaveBeenCalledTimes(1)
  })

  it('closes admission synchronously, drains all consumers, then releases authority', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    const { context, runtime } = await prepareHarness(events, (register) => {
      register(first)
      register(second)
    })
    await runtime.start()
    events.length = 0

    const firstStop = runtime.stop('authority_lost')
    const secondStop = runtime.stop('signal')
    expect(firstStop).toBe(secondStop)
    expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')
    expect(events).toEqual([])
    await firstStop

    expect(runtime.state).toBe('stopped')
    expect(events).toEqual([
      'first:cancel:authority_lost',
      'second:cancel:authority_lost',
      'first:pause:true',
      'second:pause:true',
      'first:close:false',
      'second:close:false',
      'authority:release',
    ])
  })

  it('uses graceful drain without cancelling active jobs for a process signal', async () => {
    const events: string[] = []
    const consumer = consumerHarness('consumer', events)
    const { runtime } = await prepareHarness(events, (register) => {
      register(consumer)
    })
    await runtime.start()

    await runtime.stop('signal')

    expect(consumer.cancelAllJobs).not.toHaveBeenCalledWith('signal')
    expect(consumer.pause).toHaveBeenCalledWith(true)
    expect(consumer.close).toHaveBeenCalledWith(false)
  })

  it('self-stops immediately when regional authority aborts', async () => {
    const events: string[] = []
    const consumer = consumerHarness('consumer', events)
    const onUnexpectedStop = jest.fn()
    const { abort, context, release, runtime } = await prepareHarness(
      events,
      (register) => {
        register(consumer)
      },
      onUnexpectedStop
    )
    await runtime.start()

    abort()

    expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')
    expect(onUnexpectedStop).toHaveBeenCalledTimes(1)
    expect(onUnexpectedStop.mock.calls[0][0]).toMatchObject({ code: 'authority_lost' })
    const shutdown = onUnexpectedStop.mock.calls[0][1] as Promise<void>
    await expect(shutdown).rejects.toMatchObject({ code: 'authority_lost' })
    expect(consumer.cancelAllJobs).toHaveBeenCalledWith('authority_lost')
    expect(release).toHaveBeenCalledTimes(1)
    expect(runtime.state).toBe('failed')
  })

  it('does not release authority until the final close and run loop settle', async () => {
    const events: string[] = []
    const closeGate = deferred<void>()
    const consumer = consumerHarness('consumer', events)
    ;(consumer.close as jest.Mock).mockImplementationOnce(async () => {
      events.push('consumer:close:false')
      await closeGate.promise
    })
    const { release, runtime } = await prepareHarness(events, (register) => {
      register(consumer)
    })
    await runtime.start()

    const stop = runtime.stop('signal')
    await Promise.resolve()
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()

    closeGate.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(release).not.toHaveBeenCalled()

    consumer.runTask.resolve()
    await stop
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('attempts every close but retains authority when drain fails', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    ;(first.pause as jest.Mock).mockImplementationOnce(() => {
      throw new Error('secret synchronous pause failure')
    })
    ;(second.close as jest.Mock).mockImplementationOnce(() => {
      events.push('second:close:false')
      throw new Error('secret synchronous close failure')
    })
    const { release, runtime } = await prepareHarness(events, (register) => {
      register(first)
      register(second)
    })
    await runtime.start()

    await expect(runtime.stop('signal')).rejects.toMatchObject({ code: 'stop_failed' })
    expect(first.close).toHaveBeenCalledWith(false)
    expect(second.close).toHaveBeenCalledWith(false)
    expect(release).not.toHaveBeenCalled()
    expect(runtime.state).toBe('failed')
  })

  it('attempts every prepared close after one rollback close throws synchronously', async () => {
    const events: string[] = []
    const authority = await lifecycleHarness(events)
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    const third = consumerHarness('third', events)
    ;(second.close as jest.Mock).mockImplementationOnce(() => {
      events.push('second:close:true')
      throw new Error('secret synchronous rollback failure')
    })

    await expect(
      prepareRegionConsumerRuntime({
        createConsumers: (_context, register) => {
          register(first)
          register(second)
          register(third)
          throw new Error('trigger rollback')
        },
        executionRegion: 'local',
        lifecycle: authority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'prepare_failed' })

    expect(third.close).toHaveBeenCalledWith(true)
    expect(second.close).toHaveBeenCalledWith(true)
    expect(first.close).toHaveBeenCalledWith(true)
    expect(authority.release).not.toHaveBeenCalled()
  })

  it('treats a close-time error event as failed drain even when close resolves', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    ;(first.close as jest.Mock).mockImplementationOnce(async () => {
      events.push('first:close:false')
      first.emitError(new Error('secret swallowed close failure'))
      first.runTask.resolve()
    })
    const { release, runtime } = await prepareHarness(events, (register) => {
      register(first)
    })
    await runtime.start()

    await expect(runtime.stop('signal')).rejects.toMatchObject({ code: 'stop_failed' })
    expect(release).not.toHaveBeenCalled()
    expect(runtime.state).toBe('failed')
  })

  it('fails closed and notifies once when one run loop rejects', async () => {
    const events: string[] = []
    const first = consumerHarness('first', events)
    const second = consumerHarness('second', events)
    const closeGate = deferred<void>()
    ;(second.close as jest.Mock).mockImplementationOnce(async () => {
      events.push('second:close:false')
      await closeGate.promise
      second.runTask.resolve()
    })
    const notified = deferred<void>()
    const onUnexpectedStop = jest.fn(
      (_failure: RegionConsumerRuntimeError, _shutdown: Promise<void>) => notified.resolve()
    )
    const { context, runtime } = await prepareHarness(
      events,
      (register) => {
        register(first)
        register(second)
      },
      onUnexpectedStop
    )
    await runtime.start()
    events.length = 0

    first.runTask.reject(new Error('secret run failure'))
    await notified.promise

    expect(() => context.assertCanConsume()).toThrow('consumer admission is closed')
    expect(second.cancelAllJobs).toHaveBeenCalledWith('consumer_failed')
    expect(onUnexpectedStop).toHaveBeenCalledTimes(1)
    expect(onUnexpectedStop.mock.calls[0][0]).toMatchObject({ code: 'run_failed' })
    const shutdown = onUnexpectedStop.mock.calls[0][1]
    expect(shutdown).toBeInstanceOf(Promise)
    expect(runtime.stop('signal')).toBe(shutdown)
    expect(runtime.state).toBe('stopping')

    closeGate.resolve()
    await shutdown
    expect(runtime.state).toBe('stopped')
  })

  it('rejects empty and duplicate registrations and releases only after rollback', async () => {
    const emptyEvents: string[] = []
    const emptyAuthority = await lifecycleHarness(emptyEvents)
    await expect(
      prepareRegionConsumerRuntime({
        createConsumers: () => undefined,
        executionRegion: 'local',
        lifecycle: emptyAuthority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'prepare_failed' })
    expect(emptyAuthority.release).toHaveBeenCalledTimes(1)

    const duplicateEvents: string[] = []
    const duplicateAuthority = await lifecycleHarness(duplicateEvents)
    const consumer = consumerHarness('duplicate', duplicateEvents)
    await expect(
      prepareRegionConsumerRuntime({
        createConsumers: (_context, register) => {
          register(consumer)
          register(consumer)
        },
        executionRegion: 'local',
        lifecycle: duplicateAuthority.lifecycle,
        onUnexpectedStop: jest.fn(),
      })
    ).rejects.toMatchObject({ code: 'prepare_failed' })
    expect(consumer.close).toHaveBeenCalledWith(true)
    expect(duplicateAuthority.release).toHaveBeenCalledTimes(1)
  })
})
