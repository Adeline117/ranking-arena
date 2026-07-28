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

  it('stops native and auxiliary runtimes synchronously and waits for both before cleanup', async () => {
    const nativeStop = deferred()
    const auxiliaryStop = deferred()
    const nativeRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => nativeStop.promise),
    }
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => auxiliaryStop.promise),
    }
    const { closeDatabase, closeRedis, coordinator } = coordinatorHarness()
    coordinator.bindRuntime(nativeRuntime)
    coordinator.bindAuxiliaryRuntime(auxiliaryRuntime)

    const shutdown = coordinator.requestShutdown('signal')

    expect(nativeRuntime.stop).toHaveBeenCalledWith('signal')
    expect(auxiliaryRuntime.stop).toHaveBeenCalledWith('signal')
    coordinator.settleStartup()
    nativeStop.resolve()
    await flushMicrotasks()
    await flushMicrotasks()
    expect(closeDatabase).not.toHaveBeenCalled()
    expect(closeRedis).not.toHaveBeenCalled()

    auxiliaryStop.resolve()
    await shutdown
    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(closeRedis).toHaveBeenCalledTimes(1)
  })

  it('stops an auxiliary runtime immediately when it binds after shutdown', async () => {
    const auxiliaryStop = deferred()
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => auxiliaryStop.promise),
    }
    const { closeDatabase, coordinator } = coordinatorHarness()

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.bindAuxiliaryRuntime(auxiliaryRuntime)

    expect(auxiliaryRuntime.stop).toHaveBeenCalledWith('signal')
    coordinator.settleStartup()
    await flushMicrotasks()
    expect(closeDatabase).not.toHaveBeenCalled()

    auxiliaryStop.resolve()
    await shutdown
    expect(closeDatabase).toHaveBeenCalledTimes(1)
  })

  it('binds one stable auxiliary runtime and rejects native or replacement aliases', () => {
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(async () => undefined),
    }
    const replacementRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(async () => undefined),
    }
    const first = coordinatorHarness().coordinator

    first.bindAuxiliaryRuntime(auxiliaryRuntime)
    first.bindAuxiliaryRuntime(auxiliaryRuntime)
    expect(() => first.bindAuxiliaryRuntime(replacementRuntime)).toThrow(
      expect.objectContaining({ code: 'binding_conflict' })
    )
    expect(() => first.bindRuntime(auxiliaryRuntime)).toThrow(
      expect.objectContaining({ code: 'binding_conflict' })
    )

    const second = coordinatorHarness().coordinator
    second.bindRuntime(auxiliaryRuntime)
    expect(() => second.bindAuxiliaryRuntime(auxiliaryRuntime)).toThrow(
      expect.objectContaining({ code: 'binding_conflict' })
    )
    expect(auxiliaryRuntime.stop).not.toHaveBeenCalled()
    expect(replacementRuntime.stop).not.toHaveBeenCalled()
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

  it('tracks native and auxiliary stop priorities independently across late binding and upgrades', async () => {
    const nativeRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(async () => undefined),
    }
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(async () => undefined),
    }
    const { coordinator } = coordinatorHarness()
    coordinator.bindRuntime(nativeRuntime)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.bindAuxiliaryRuntime(auxiliaryRuntime)
    coordinator.requestShutdown('consumer_failed')
    coordinator.requestShutdown('authority_lost')
    coordinator.requestShutdown('startup_failed')

    expect(nativeRuntime.stop).toHaveBeenNthCalledWith(1, 'signal')
    expect(nativeRuntime.stop).toHaveBeenNthCalledWith(2, 'consumer_failed')
    expect(nativeRuntime.stop).toHaveBeenNthCalledWith(3, 'authority_lost')
    expect(auxiliaryRuntime.stop).toHaveBeenNthCalledWith(1, 'signal')
    expect(auxiliaryRuntime.stop).toHaveBeenNthCalledWith(2, 'consumer_failed')
    expect(auxiliaryRuntime.stop).toHaveBeenNthCalledWith(3, 'authority_lost')
    expect(nativeRuntime.stop).toHaveBeenCalledTimes(3)
    expect(auxiliaryRuntime.stop).toHaveBeenCalledTimes(3)

    coordinator.settleStartup()
    await shutdown
  })

  it('keeps native bare lifecycle release independent from an auxiliary runtime', async () => {
    const auxiliaryStop = deferred()
    const lifecycle = lifecycleHarness()
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => auxiliaryStop.promise),
    }
    const { closeDatabase, coordinator } = coordinatorHarness()
    coordinator.bindLifecycle(lifecycle)
    coordinator.bindAuxiliaryRuntime(auxiliaryRuntime)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    await flushMicrotasks()
    await flushMicrotasks()

    expect(lifecycle.stopAfterDrain).toHaveBeenCalledTimes(1)
    expect(auxiliaryRuntime.stop).toHaveBeenCalledWith('signal')
    expect(closeDatabase).not.toHaveBeenCalled()

    auxiliaryStop.resolve()
    await shutdown
    expect(closeDatabase).toHaveBeenCalledTimes(1)
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

  it('isolates a synchronous auxiliary stop failure and still stops native and closes resources', async () => {
    const nativeRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(async () => undefined),
    }
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => {
        throw new Error('secret synchronous auxiliary stop failure')
      }),
    }
    const { closeDatabase, closeRedis, coordinator, markFatal, setExitCode } = coordinatorHarness()
    coordinator.bindRuntime(nativeRuntime)
    coordinator.bindAuxiliaryRuntime(auxiliaryRuntime)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    await shutdown

    expect(nativeRuntime.stop).toHaveBeenCalledWith('signal')
    expect(auxiliaryRuntime.stop).toHaveBeenCalledWith('signal')
    expect(markFatal).toHaveBeenCalledWith('regional_stop_failed')
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(closeRedis).toHaveBeenCalledTimes(1)
  })

  it('observes an asynchronous auxiliary stop rejection before closing resources', async () => {
    const auxiliaryStop = deferred()
    const auxiliaryRuntime: NativeProcessRegionalRuntime = {
      stop: jest.fn(() => auxiliaryStop.promise),
    }
    const { closeDatabase, closeRedis, coordinator, markFatal, setExitCode } = coordinatorHarness()
    coordinator.bindAuxiliaryRuntime(auxiliaryRuntime)

    const shutdown = coordinator.requestShutdown('signal')
    coordinator.settleStartup()
    await flushMicrotasks()
    expect(closeDatabase).not.toHaveBeenCalled()
    expect(closeRedis).not.toHaveBeenCalled()

    auxiliaryStop.reject(new Error('secret asynchronous auxiliary stop failure'))
    await shutdown

    expect(markFatal).toHaveBeenCalledWith('regional_stop_failed')
    expect(setExitCode).toHaveBeenCalledWith(1)
    expect(closeDatabase).toHaveBeenCalledTimes(1)
    expect(closeRedis).toHaveBeenCalledTimes(1)
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
