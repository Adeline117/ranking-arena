import {
  createNativeProcessCoordinator,
  type NativeProcessAuthorityLifecycle,
  type NativeProcessCoordinator,
  type NativeProcessFatalCode,
  type NativeProcessRegionalRuntime,
} from '../native-process-coordinator'

function deferred<T = void>() {
  let reject!: (reason?: unknown) => void
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    reject = rejectPromise
    resolve = resolvePromise
  })
  return { promise, reject, resolve }
}

function flushMicrotasks(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

function lifecycleHarness(events: string[] = []): NativeProcessAuthorityLifecycle & {
  stopAfterDrain: jest.Mock<Promise<void>, [() => Promise<void>]>
} {
  return {
    stopAfterDrain: jest.fn(async (drain: () => Promise<void>) => {
      events.push('lifecycle:stop')
      await drain()
      events.push('lifecycle:stopped')
    }),
  }
}

function coordinatorHarness(overrides?: {
  closeDatabase?: () => PromiseLike<void> | void
  closeRedis?: () => PromiseLike<void> | void
  markFatal?: (code: NativeProcessFatalCode) => void
  setExitCode?: (code: number) => void
}) {
  const events: string[] = []
  const closeDatabase = jest.fn(
    overrides?.closeDatabase ??
      (async () => {
        events.push('database:close')
      })
  )
  const closeRedis = jest.fn(
    overrides?.closeRedis ??
      (async () => {
        events.push('redis:close')
      })
  )
  const markFatal = jest.fn(overrides?.markFatal ?? (() => undefined))
  const setExitCode = jest.fn(overrides?.setExitCode ?? (() => undefined))
  const coordinator = createNativeProcessCoordinator({
    closeDatabase,
    closeRedis,
    markFatal,
    setExitCode,
  })
  return { closeDatabase, closeRedis, coordinator, events, markFatal, setExitCode }
}

describe('native process coordinator', () => {
  it('aborts startup with a sanitized assertion and can receive a lifecycle after shutdown', async () => {
    const { coordinator, closeDatabase, closeRedis } = coordinatorHarness()
    const lifecycle = lifecycleHarness()

    coordinator.assertStartupOpen()
    const shutdown = coordinator.requestShutdown('signal')

    expect(coordinator.startupSignal.aborted).toBe(true)
    expect(() => coordinator.assertStartupOpen()).toThrow(
      '[ingest-worker] native process coordinator failed (startup_closed)'
    )
    expect(coordinator.startupSignal.reason).toMatchObject({ code: 'startup_closed' })

    coordinator.bindLifecycle(lifecycle)
    await flushMicrotasks()

    expect(lifecycle.stopAfterDrain).not.toHaveBeenCalled()
    expect(closeDatabase).not.toHaveBeenCalled()
    expect(closeRedis).not.toHaveBeenCalled()

    coordinator.settleStartup()
    await shutdown

    expect(lifecycle.stopAfterDrain).toHaveBeenCalledTimes(1)
    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(closeRedis).toHaveBeenCalledTimes(1)
  })

  it('never performs a bare release while startup preparation remains unsettled', async () => {
    const { coordinator } = coordinatorHarness()
    const lifecycle = lifecycleHarness()
    coordinator.bindLifecycle(lifecycle)

    const shutdown = coordinator.requestShutdown('startup_failed')
    await flushMicrotasks()
    await flushMicrotasks()

    expect(lifecycle.stopAfterDrain).not.toHaveBeenCalled()

    coordinator.settleStartup()
    await shutdown
    expect(lifecycle.stopAfterDrain).toHaveBeenCalledTimes(1)
  })

  it('stops a runtime synchronously when it binds after a shutdown request', async () => {
    const regionalStop = deferred()
    const lifecycle = lifecycleHarness()
    const runtime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => regionalStop.promise),
    }
    const { closeDatabase, coordinator } = coordinatorHarness()

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.bindLifecycle(lifecycle)
    coordinator.bindRuntime(runtime)

    expect(runtime.stop).toHaveBeenCalledWith('signal')
    coordinator.settleStartup()
    await flushMicrotasks()
    expect(closeDatabase).not.toHaveBeenCalled()

    regionalStop.resolve()
    await shutdown

    expect(lifecycle.stopAfterDrain).not.toHaveBeenCalled()
    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('upgrades the runtime stop reason while preserving one global cleanup promise', async () => {
    const regionalStop = deferred()
    const runtime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => regionalStop.promise),
    }
    const { coordinator, markFatal, setExitCode } = coordinatorHarness()
    coordinator.bindRuntime(runtime)

    const signalShutdown = coordinator.requestShutdown('signal')
    const authorityShutdown = coordinator.requestShutdown('authority_lost')
    const weakerShutdown = coordinator.requestShutdown('startup_failed')

    expect(authorityShutdown).toBe(signalShutdown)
    expect(weakerShutdown).toBe(signalShutdown)
    expect(runtime.stop).toHaveBeenNthCalledWith(1, 'signal')
    expect(runtime.stop).toHaveBeenNthCalledWith(2, 'authority_lost')
    expect(runtime.stop).toHaveBeenCalledTimes(2)
    expect(coordinator.shutdownReason).toBe('authority_lost')
    expect(markFatal).toHaveBeenCalledWith('authority_lost')
    expect(setExitCode).toHaveBeenCalledWith(1)

    coordinator.settleStartup()
    regionalStop.resolve()
    await signalShutdown
  })

  it('waits for an upgraded regional stop added while reconciliation is draining', async () => {
    const reconcile = deferred()
    const authorityStop = deferred()
    const runtime: NativeProcessRegionalRuntime = {
      stop: jest
        .fn<Promise<void>, [Parameters<NativeProcessRegionalRuntime['stop']>[0]]>()
        .mockResolvedValueOnce()
        .mockImplementationOnce(() => authorityStop.promise),
    }
    const { closeDatabase, coordinator } = coordinatorHarness()
    coordinator.bindRuntime(runtime)
    coordinator.trackReconcile(reconcile.promise)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    await flushMicrotasks()
    coordinator.requestShutdown('authority_lost')
    reconcile.resolve()
    await flushMicrotasks()
    await flushMicrotasks()

    expect(closeDatabase).not.toHaveBeenCalled()

    authorityStop.resolve()
    await shutdown
    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('supports an authority-loss callback before acquisition returns without a TDZ', async () => {
    const lifecycle = lifecycleHarness()
    const { coordinator } = coordinatorHarness()
    let shutdown: Promise<void> | undefined

    const acquire = async (): Promise<NativeProcessAuthorityLifecycle> => {
      shutdown = coordinator.requestShutdown('authority_lost')
      await flushMicrotasks()
      return lifecycle
    }

    coordinator.bindLifecycle(await acquire())
    expect(lifecycle.stopAfterDrain).not.toHaveBeenCalled()
    coordinator.settleStartup()
    await shutdown

    expect(lifecycle.stopAfterDrain).toHaveBeenCalledTimes(1)
  })

  it('clears timers synchronously and idempotently, including timers bound after shutdown', async () => {
    const { closeDatabase, coordinator, markFatal } = coordinatorHarness()
    const heartbeatClear = jest.fn(() => {
      throw new Error('secret heartbeat clear failure')
    })
    const reconcileClear = jest.fn()

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.bindHeartbeatTimer(heartbeatClear)
    coordinator.bindReconcileTimer(reconcileClear)

    expect(heartbeatClear).toHaveBeenCalledTimes(1)
    expect(reconcileClear).toHaveBeenCalledTimes(1)
    expect(markFatal).toHaveBeenCalledWith('timer_clear_failed')
    expect(coordinator.requestShutdown('signal')).toBe(shutdown)
    expect(heartbeatClear).toHaveBeenCalledTimes(1)
    expect(reconcileClear).toHaveBeenCalledTimes(1)

    coordinator.settleStartup()
    await shutdown
    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('observes a supplied regional rejection before the startup barrier settles', async () => {
    const regionalStop = deferred()
    const { closeDatabase, coordinator, markFatal } = coordinatorHarness()

    const shutdown = coordinator.requestShutdown('signal', regionalStop.promise)
    regionalStop.reject(new Error('secret regional failure'))
    await flushMicrotasks()
    await flushMicrotasks()

    expect(closeDatabase).not.toHaveBeenCalled()

    coordinator.settleStartup()
    await shutdown
    expect(markFatal).toHaveBeenCalledWith('regional_stop_failed')
  })

  it('waits for every in-flight reconciliation before database and Redis cleanup', async () => {
    const firstReconcile = deferred()
    const secondReconcile = deferred()
    const { closeDatabase, closeRedis, coordinator, events } = coordinatorHarness()
    coordinator.trackReconcile(firstReconcile.promise)
    coordinator.trackReconcile(secondReconcile.promise)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    firstReconcile.resolve()
    await flushMicrotasks()
    await flushMicrotasks()

    expect(closeDatabase).not.toHaveBeenCalled()
    expect(closeRedis).not.toHaveBeenCalled()

    secondReconcile.resolve()
    await shutdown
    expect(events).toEqual(['database:close', 'redis:close'])
    expect(coordinator.shutdownReason).toBe('signal')
  })

  it('marks a rejected reconciliation fatal while continuing cleanup', async () => {
    const reconcile = deferred()
    const { closeDatabase, closeRedis, coordinator, markFatal, setExitCode } = coordinatorHarness()
    coordinator.trackReconcile(reconcile.promise)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    reconcile.reject(new Error('secret reconciliation failure'))
    await shutdown

    expect(markFatal).toHaveBeenCalledWith('reconcile_failed')
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(closeRedis).toHaveBeenCalledTimes(1)
  })

  it('does not turn a reconciliation handled before shutdown into a fatal exit', async () => {
    const reconcile = deferred()
    const { coordinator, markFatal, setExitCode } = coordinatorHarness()
    coordinator.trackReconcile(reconcile.promise)
    reconcile.reject(new Error('already handled reconciliation failure'))
    await flushMicrotasks()
    await flushMicrotasks()

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    await shutdown

    expect(markFatal).not.toHaveBeenCalled()
    expect(setExitCode).not.toHaveBeenCalled()
  })

  it('continues through regional, database and Redis cleanup failures and marks fatal', async () => {
    const runtime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => Promise.reject(new Error('secret regional stop failure'))),
    }
    const events: string[] = []
    const { coordinator, markFatal, setExitCode } = coordinatorHarness({
      closeDatabase: async () => {
        events.push('database:close')
        throw new Error('secret database close failure')
      },
      closeRedis: async () => {
        events.push('redis:close')
        throw new Error('secret redis close failure')
      },
    })
    coordinator.bindRuntime(runtime)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    await shutdown

    expect(runtime.stop).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['database:close', 'redis:close'])
    expect(markFatal).toHaveBeenCalledWith('regional_stop_failed')
    expect(markFatal).toHaveBeenCalledTimes(1)
    expect(setExitCode).toHaveBeenCalledTimes(1)
  })

  it('settles duplicate requests once and performs exactly one bare lifecycle release', async () => {
    const events: string[] = []
    const lifecycle = lifecycleHarness(events)
    const { closeDatabase, closeRedis, coordinator } = coordinatorHarness()
    coordinator.bindLifecycle(lifecycle)

    const first = coordinator.requestShutdown('signal')
    const second = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    coordinator.settleStartup()

    expect(second).toBe(first)
    await first

    expect(events).toEqual(['lifecycle:stop', 'lifecycle:stopped'])
    expect(lifecycle.stopAfterDrain).toHaveBeenCalledTimes(1)
    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(closeRedis).toHaveBeenCalledTimes(1)
  })

  it('keeps the same promise across synchronous timer and shutdown callback re-entry', async () => {
    let reenteredShutdown: Promise<void> | undefined
    const harness = coordinatorHarness()
    const coordinator: NativeProcessCoordinator = harness.coordinator
    coordinator.bindHeartbeatTimer(() => {
      coordinator.settleStartup()
      reenteredShutdown = coordinator.requestShutdown('consumer_failed')
    })

    const shutdown = coordinator.requestShutdown('signal')

    expect(reenteredShutdown).toBe(shutdown)
    expect(coordinator.shutdownReason).toBe('consumer_failed')
    await shutdown
    expect(harness.markFatal).toHaveBeenCalledWith('consumer_failed')
    expect(harness.closeDatabase).toHaveBeenCalledTimes(1)
    expect(harness.closeRedis).toHaveBeenCalledTimes(1)
  })
})
