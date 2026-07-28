import {
  acquireRegionAuthorityLifecycle,
  RegionAuthorityLifecycleError,
  type RegionAuthorityLifecycle,
} from '../region-authority-lifecycle'
import type {
  AcquireWorkerDbFenceResult,
  WorkerDbFence,
  WorkerDbFenceProof,
} from '../worker-db-fence'
import type { WorkerOwnershipHeartbeatInput } from '../worker-instance-ownership'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function heartbeat(region: 'local' | 'vps_sg' = 'local'): WorkerOwnershipHeartbeatInput {
  return {
    attempt_bound_capture: true,
    node: 'authority-runtime-test',
    pid: 42,
    regions: [region],
    release_id: 'a'.repeat(64),
    sha: 'b'.repeat(40),
  }
}

function proof(region: 'local' | 'vps_sg' = 'local'): WorkerDbFenceProof {
  return {
    authorityScope: `region:${region}`,
    controlEpoch: 1,
    controlServerTimeMs: 1_000,
    databaseEpoch: 1,
    databaseLeaseExpiresAt: '2026-07-28T20:03:00.000Z',
    databaseServerTime: '2026-07-28T20:00:00.000Z',
    initialControlServerTimeMs: 1_000,
    instanceId: '00000000-0000-4000-8000-000000000001',
    nodeId: 'authority-runtime-test',
    region,
  }
}

function fenceHarness(region: 'local' | 'vps_sg' = 'local') {
  const controller = new AbortController()
  const events: string[] = []
  const renewAndPublish = jest.fn(async () => {
    events.push('renew')
  })
  const release = jest.fn(async () => {
    events.push('release')
    controller.abort(new Error('intentional release'))
  })
  const fence: WorkerDbFence = {
    proof: proof(region),
    signal: controller.signal,
    state: 'active',
    isActive: () => !controller.signal.aborted,
    release,
    renewAndPublish,
    withFencedWrite: jest.fn(),
  }
  return { controller, events, fence, release, renewAndPublish }
}

function schedulerHarness() {
  const callbacks: Array<() => void> = []
  const delays: number[] = []
  const cancelled: unknown[] = []
  const scheduleRenewal = jest.fn((callback: () => void, delayMs: number) => {
    callbacks.push(callback)
    delays.push(delayMs)
    const timer = {
      cancel: jest.fn(() => cancelled.push(timer)),
      unref: jest.fn(),
    }
    return timer
  })
  return { callbacks, cancelled, delays, scheduleRenewal }
}

async function startActive({
  fence = fenceHarness(),
  onLost = jest.fn(),
  scheduler = schedulerHarness(),
}: {
  fence?: ReturnType<typeof fenceHarness>
  onLost?: jest.Mock
  scheduler?: ReturnType<typeof schedulerHarness>
} = {}): Promise<{
  fence: ReturnType<typeof fenceHarness>
  lifecycle: RegionAuthorityLifecycle
  onLost: jest.Mock
  scheduler: ReturnType<typeof schedulerHarness>
}> {
  const acquireAuthority = jest.fn(
    async (): Promise<AcquireWorkerDbFenceResult> => ({ fence: fence.fence, status: 'active' })
  )
  const result = await acquireRegionAuthorityLifecycle({
    acquireAuthority,
    heartbeat,
    onLost,
    redis: { eval: jest.fn() },
    region: 'local',
    scheduleRenewal: scheduler.scheduleRenewal,
  })
  if (result.status !== 'active') throw new Error('expected active lifecycle')
  return { fence, lifecycle: result.lifecycle, onLost, scheduler }
}

describe('region authority lifecycle orchestration', () => {
  it('returns contention without starting a renewal or creating hidden authority', async () => {
    const scheduler = schedulerHarness()
    const result = await acquireRegionAuthorityLifecycle({
      acquireAuthority: async () => ({
        authorityScope: 'region:local',
        observedControlEpoch: 7,
        observedControlServerTimeMs: 9_000,
        region: 'local',
        status: 'contended',
      }),
      heartbeat,
      onLost: jest.fn(),
      redis: { eval: jest.fn() },
      region: 'local',
      scheduleRenewal: scheduler.scheduleRenewal,
    })

    expect(result).toEqual({
      authorityScope: 'region:local',
      observedControlEpoch: 7,
      observedControlServerTimeMs: 9_000,
      region: 'local',
      status: 'contended',
    })
    expect(scheduler.scheduleRenewal).not.toHaveBeenCalled()
  })

  it('rejects a contended proof for a different authority scope', async () => {
    await expect(
      acquireRegionAuthorityLifecycle({
        acquireAuthority: async () =>
          ({
            authorityScope: 'region:vps_sg',
            observedControlEpoch: 7,
            observedControlServerTimeMs: 9_000,
            region: 'local',
            status: 'contended',
          }) as AcquireWorkerDbFenceResult,
        heartbeat,
        onLost: jest.fn(),
        redis: { eval: jest.fn() },
        region: 'local',
      })
    ).rejects.toMatchObject({ code: 'proof_mismatch', region: 'local' })
  })

  it('rejects a heartbeat that tries to acquire a different region', async () => {
    const acquireAuthority = jest.fn()
    await expect(
      acquireRegionAuthorityLifecycle({
        acquireAuthority,
        heartbeat: () => heartbeat('vps_sg'),
        onLost: jest.fn(),
        redis: { eval: jest.fn() },
        region: 'local',
      })
    ).rejects.toMatchObject({ code: 'heartbeat_invalid', region: 'local' })
    expect(acquireAuthority).not.toHaveBeenCalled()
  })

  it('releases a mismatched active proof before rejecting it', async () => {
    const wrong = fenceHarness('vps_sg')
    await expect(
      acquireRegionAuthorityLifecycle({
        acquireAuthority: async () => ({ fence: wrong.fence, status: 'active' }),
        heartbeat,
        onLost: jest.fn(),
        redis: { eval: jest.fn() },
        region: 'local',
      })
    ).rejects.toMatchObject({ code: 'proof_mismatch', region: 'local' })
    expect(wrong.release).toHaveBeenCalledTimes(1)
  })

  it('releases authority when the first renewal cannot be scheduled', async () => {
    const harness = fenceHarness()
    const onLost = jest.fn()
    await expect(
      acquireRegionAuthorityLifecycle({
        acquireAuthority: async () => ({ fence: harness.fence, status: 'active' }),
        heartbeat,
        onLost,
        redis: { eval: jest.fn() },
        region: 'local',
        scheduleRenewal: () => {
          throw new Error('timer unavailable with secret')
        },
      })
    ).rejects.toMatchObject({ code: 'renew_schedule_failed', region: 'local' })
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(onLost).toHaveBeenCalledTimes(1)
  })

  it('releases an authority that is already aborted before startup can return it', async () => {
    const harness = fenceHarness()
    harness.controller.abort(new Error('expired authority with secret'))
    await expect(
      acquireRegionAuthorityLifecycle({
        acquireAuthority: async () => ({ fence: harness.fence, status: 'active' }),
        heartbeat,
        onLost: jest.fn(),
        redis: { eval: jest.fn() },
        region: 'local',
      })
    ).rejects.toMatchObject({ code: 'authority_lost', region: 'local' })
    expect(harness.release).toHaveBeenCalledTimes(1)
  })

  it('runs renewals as a single flight and schedules the next tick only after settlement', async () => {
    const harness = fenceHarness()
    const firstRenewal = deferred<void>()
    harness.renewAndPublish.mockImplementationOnce(() => firstRenewal.promise)
    const { lifecycle, scheduler } = await startActive({ fence: harness })

    expect(scheduler.delays).toEqual([30_000])
    scheduler.callbacks[0]()
    expect(harness.renewAndPublish).toHaveBeenCalledTimes(1)
    expect(scheduler.scheduleRenewal).toHaveBeenCalledTimes(1)

    firstRenewal.resolve()
    await firstRenewal.promise
    await Promise.resolve()
    await Promise.resolve()
    expect(scheduler.scheduleRenewal).toHaveBeenCalledTimes(2)

    await lifecycle.stopAfterDrain(async () => undefined)
  })

  it('exposes a frozen write-only fence capability without lifecycle controls', async () => {
    const { lifecycle } = await startActive()

    expect(Object.isFrozen(lifecycle.fence)).toBe(true)
    expect(Object.keys(lifecycle.fence).sort()).toEqual(
      ['isActive', 'proof', 'signal', 'state', 'withFencedWrite'].sort()
    )
    expect('release' in lifecycle.fence).toBe(false)
    expect('renewAndPublish' in lifecycle.fence).toBe(false)

    await lifecycle.stopAfterDrain(async () => undefined)
  })

  it('fails closed when scheduling the next renewal throws after a successful tick', async () => {
    const scheduler = schedulerHarness()
    scheduler.scheduleRenewal.mockImplementationOnce((callback: () => void, delayMs: number) => {
      scheduler.callbacks.push(callback)
      scheduler.delays.push(delayMs)
      return { cancel: jest.fn(), unref: jest.fn() }
    })
    scheduler.scheduleRenewal.mockImplementationOnce(() => {
      throw new Error('timer reschedule secret')
    })
    const { lifecycle, onLost } = await startActive({ scheduler })

    scheduler.callbacks[0]()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(lifecycle.state).toBe('lost')
    expect(lifecycle.failure).toMatchObject({ code: 'renew_schedule_failed', region: 'local' })
    expect(onLost).toHaveBeenCalledTimes(1)
    await expect(lifecycle.stopAfterDrain(async () => undefined)).rejects.toBe(lifecycle.failure)
  })

  it('coalesces a renew rejection and fence abort into one sanitized loss', async () => {
    const harness = fenceHarness()
    harness.renewAndPublish.mockImplementationOnce(async () => {
      harness.controller.abort(new Error('rediss://secret-token'))
      throw new Error('postgres://secret-password')
    })
    const { lifecycle, onLost, scheduler } = await startActive({ fence: harness })

    scheduler.callbacks[0]()
    await Promise.resolve()
    await Promise.resolve()

    expect(lifecycle.state).toBe('lost')
    expect(onLost).toHaveBeenCalledTimes(1)
    const failure = onLost.mock.calls[0][0] as RegionAuthorityLifecycleError
    expect(failure).toMatchObject({ code: 'authority_lost', region: 'local' })
    expect(failure.message).not.toContain('secret')
    await expect(lifecycle.stopAfterDrain(async () => undefined)).rejects.toBe(failure)
  })

  it('keeps renewal alive throughout drain and releases only after drain settles', async () => {
    const { fence, lifecycle, scheduler } = await startActive()
    const draining = deferred<void>()
    const stop = lifecycle.stopAfterDrain(async () => {
      fence.events.push('drain:start')
      await draining.promise
      fence.events.push('drain:end')
    })

    expect(lifecycle.state).toBe('stopping')
    scheduler.callbacks[0]()
    await Promise.resolve()
    expect(fence.events).toEqual(expect.arrayContaining(['drain:start', 'renew']))
    expect(fence.release).not.toHaveBeenCalled()

    draining.resolve()
    await stop
    expect(fence.events.slice(-2)).toEqual(['drain:end', 'release'])
    expect(lifecycle.state).toBe('stopped')
  })

  it('waits for an in-flight renewal before releasing during shutdown', async () => {
    const harness = fenceHarness()
    const renewing = deferred<void>()
    harness.renewAndPublish.mockImplementationOnce(async () => {
      harness.events.push('renew:start')
      await renewing.promise
      harness.events.push('renew:end')
    })
    const { lifecycle, scheduler } = await startActive({ fence: harness })
    scheduler.callbacks[0]()
    const stop = lifecycle.stopAfterDrain(async () => {
      harness.events.push('drain')
    })

    await Promise.resolve()
    expect(harness.events).toEqual(['renew:start', 'drain'])
    expect(harness.release).not.toHaveBeenCalled()

    renewing.resolve()
    await stop
    expect(harness.events).toEqual(['renew:start', 'drain', 'renew:end', 'release'])
  })

  it('does not release authority when drain fails', async () => {
    const { fence, lifecycle, onLost } = await startActive()
    const first = lifecycle.stopAfterDrain(async () => {
      throw new Error('consumer still running with secret')
    })
    const second = lifecycle.stopAfterDrain(async () => undefined)

    expect(second).toBe(first)
    await expect(first).rejects.toMatchObject({ code: 'drain_failed', region: 'local' })
    await expect(second).rejects.toMatchObject({ code: 'drain_failed', region: 'local' })
    expect(fence.release).not.toHaveBeenCalled()
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(lifecycle.state).toBe('lost')
  })

  it('memoizes stop before invoking a synchronously reentrant drain', async () => {
    const { lifecycle } = await startActive()
    const barrier = deferred<void>()
    const secondDrain = jest.fn(async () => undefined)
    let nested: Promise<void> | undefined
    const outer = lifecycle.stopAfterDrain(async () => {
      nested = lifecycle.stopAfterDrain(secondDrain)
      await barrier.promise
    })

    await Promise.resolve()
    expect(nested).toBe(outer)
    expect(secondDrain).not.toHaveBeenCalled()
    barrier.resolve()
    await outer
  })

  it('memoizes a healthy shutdown release failure and reports it once', async () => {
    const harness = fenceHarness()
    harness.release.mockRejectedValueOnce(new Error('release transport secret'))
    const { lifecycle, onLost } = await startActive({ fence: harness })
    const first = lifecycle.stopAfterDrain(async () => undefined)
    const second = lifecycle.stopAfterDrain(async () => undefined)

    expect(second).toBe(first)
    await expect(first).rejects.toMatchObject({ code: 'release_failed', region: 'local' })
    await expect(second).rejects.toBe(lifecycle.failure)
    expect(lifecycle.state).toBe('lost')
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(harness.release).toHaveBeenCalledTimes(1)
  })

  it('preserves the original authority loss when later release cleanup fails', async () => {
    const harness = fenceHarness()
    harness.release.mockRejectedValueOnce(new Error('release transport secret'))
    const { lifecycle, onLost, scheduler } = await startActive({ fence: harness })
    harness.renewAndPublish.mockRejectedValueOnce(new Error('renew transport secret'))

    scheduler.callbacks[0]()
    await Promise.resolve()
    await Promise.resolve()
    const original = lifecycle.failure
    const first = lifecycle.stopAfterDrain(async () => undefined)
    const second = lifecycle.stopAfterDrain(async () => undefined)
    expect(second).toBe(first)
    await expect(first).rejects.toBe(original)
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(lifecycle.failure).toBe(original)
    expect(lifecycle.failure?.message).not.toContain('secret')
    expect(harness.release).toHaveBeenCalledTimes(1)
  })

  it('reports the original authority loss even when cleanup releases successfully', async () => {
    const harness = fenceHarness()
    const { lifecycle, onLost, scheduler } = await startActive({ fence: harness })
    harness.renewAndPublish.mockRejectedValueOnce(new Error('renew transport secret'))

    scheduler.callbacks[0]()
    await Promise.resolve()
    await Promise.resolve()
    const original = lifecycle.failure
    await expect(lifecycle.stopAfterDrain(async () => undefined)).rejects.toBe(original)
    expect(harness.release).toHaveBeenCalledTimes(1)
    expect(onLost).toHaveBeenCalledTimes(1)
    expect(lifecycle.state).toBe('stopped')
  })
})
