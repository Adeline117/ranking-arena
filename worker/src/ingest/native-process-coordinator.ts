import type { RegionConsumerStopReason } from './region-consumer-runtime'

export type NativeProcessShutdownReason = RegionConsumerStopReason

export type NativeProcessFatalCode =
  | 'authority_lost'
  | 'binding_conflict'
  | 'consumer_failed'
  | 'database_close_failed'
  | 'reconcile_failed'
  | 'redis_close_failed'
  | 'regional_stop_failed'
  | 'startup_failed'
  | 'timer_clear_failed'

export type NativeProcessCoordinatorErrorCode = 'binding_conflict' | 'startup_closed'

export class NativeProcessCoordinatorError extends Error {
  readonly code: NativeProcessCoordinatorErrorCode

  constructor(code: NativeProcessCoordinatorErrorCode) {
    super(`[ingest-worker] native process coordinator failed (${code})`)
    this.name = 'NativeProcessCoordinatorError'
    this.code = code
  }
}

/** The only authority operation the process coordinator may own directly. */
export interface NativeProcessAuthorityLifecycle {
  stopAfterDrain(drain: () => Promise<void>): Promise<void>
}

/** The only regional runtime operation needed by process shutdown. */
export interface NativeProcessRegionalRuntime {
  stop(reason: NativeProcessShutdownReason): Promise<void>
}

export interface NativeProcessCoordinatorOptions {
  closeDatabase: () => PromiseLike<void> | void
  closeRedis: () => PromiseLike<void> | void
  markFatal: (code: NativeProcessFatalCode) => void
  setExitCode: (code: number) => void
}

export interface NativeProcessCoordinator {
  readonly shutdownReason: NativeProcessShutdownReason | undefined
  readonly startupSettled: boolean
  readonly startupSignal: AbortSignal
  assertStartupOpen(): void
  bindAuxiliaryRuntime(runtime: NativeProcessRegionalRuntime): void
  bindHeartbeatTimer(clear: () => void): void
  bindAttemptHealthTimer(clear: () => void): void
  bindLifecycle(lifecycle: NativeProcessAuthorityLifecycle): void
  bindReconcileTimer(clear: () => void): void
  bindRuntime(runtime: NativeProcessRegionalRuntime): void
  requestShutdown(
    reason: NativeProcessShutdownReason,
    regionalStop?: PromiseLike<void>
  ): Promise<void>
  settleStartup(): void
  trackReconcile(operation: PromiseLike<unknown>): void
}

interface BoundTimer {
  readonly clear: () => void
  cleared: boolean
}

interface TrackedOperation {
  readonly completion: Promise<void>
}

const SHUTDOWN_PRIORITY: Readonly<Record<NativeProcessShutdownReason, number>> = Object.freeze({
  signal: 0,
  startup_failed: 1,
  consumer_failed: 2,
  authority_lost: 3,
})

function coordinatorError(code: NativeProcessCoordinatorErrorCode): NativeProcessCoordinatorError {
  return new NativeProcessCoordinatorError(code)
}

/**
 * Coordinates process-wide shutdown without taking ownership away from a
 * regional runtime while that runtime may still be preparing consumers.
 * settleStartup() is the explicit hand-off point: callers must bind any
 * acquired lifecycle and successfully prepared runtime before settling it.
 */
export function createNativeProcessCoordinator({
  closeDatabase,
  closeRedis,
  markFatal,
  setExitCode,
}: NativeProcessCoordinatorOptions): NativeProcessCoordinator {
  const startupController = new AbortController()
  let resolveStartupSettled!: () => void
  const startupSettledBarrier = new Promise<void>((resolve) => {
    resolveStartupSettled = resolve
  })

  const reconcileOperations = new Set<TrackedOperation>()
  const shutdownReconcileOperations = new Set<TrackedOperation>()
  const regionalStopOperations = new Set<TrackedOperation>()
  let auxiliaryRuntime: NativeProcessRegionalRuntime | undefined
  let auxiliaryRuntimeStopPriority = -1
  let attemptHealthTimer: BoundTimer | undefined
  let bareReleaseAttempted = false
  let cleanupPromise: Promise<void> | undefined
  let fatalMarked = false
  let heartbeatTimer: BoundTimer | undefined
  let lifecycle: NativeProcessAuthorityLifecycle | undefined
  let reconcileFailed = false
  let reconcileTimer: BoundTimer | undefined
  let regionalStopFailed = false
  let runtime: NativeProcessRegionalRuntime | undefined
  let runtimeStopPriority = -1
  let shutdownReason: NativeProcessShutdownReason | undefined
  let startupSettled = false

  const markFatalOnce = (code: NativeProcessFatalCode): void => {
    if (fatalMarked) return
    fatalMarked = true
    try {
      markFatal(code)
    } catch {
      // A reporting callback must not prevent the resource cleanup path.
    }
    try {
      setExitCode(1)
    } catch {
      // The coordinator still completes cleanup if the host cannot set a code.
    }
  }

  const observe = (
    operation: PromiseLike<unknown>,
    operations: Set<TrackedOperation>,
    onRejected?: (tracked: TrackedOperation) => void,
    onSettled?: (tracked: TrackedOperation) => void
  ): TrackedOperation => {
    const tracked: TrackedOperation = {
      completion: Promise.resolve(operation).then(
        () => {
          operations.delete(tracked)
          onSettled?.(tracked)
        },
        () => {
          operations.delete(tracked)
          try {
            onRejected?.(tracked)
          } finally {
            onSettled?.(tracked)
          }
        }
      ),
    }
    operations.add(tracked)
    return tracked
  }

  const observeRegionalStop = (operation: PromiseLike<void>): void => {
    observe(operation, regionalStopOperations, () => {
      regionalStopFailed = true
    })
  }

  const recordSynchronousRegionalStopFailure = (): void => {
    regionalStopFailed = true
  }

  const clearTimer = (timer: BoundTimer | undefined): void => {
    if (timer === undefined || timer.cleared) return
    timer.cleared = true
    try {
      timer.clear()
    } catch {
      markFatalOnce('timer_clear_failed')
    }
  }

  const clearBoundTimers = (): void => {
    clearTimer(attemptHealthTimer)
    clearTimer(heartbeatTimer)
    clearTimer(reconcileTimer)
  }

  const strongestReason = (): NativeProcessShutdownReason => shutdownReason ?? 'signal'

  const dispatchRuntimeStop = (): void => {
    if (runtime === undefined || shutdownReason === undefined) return
    const priority = SHUTDOWN_PRIORITY[shutdownReason]
    if (priority <= runtimeStopPriority) return
    runtimeStopPriority = priority
    try {
      observeRegionalStop(runtime.stop(shutdownReason))
    } catch {
      recordSynchronousRegionalStopFailure()
    }
  }

  const dispatchAuxiliaryRuntimeStop = (): void => {
    if (auxiliaryRuntime === undefined || shutdownReason === undefined) return
    const priority = SHUTDOWN_PRIORITY[shutdownReason]
    if (priority <= auxiliaryRuntimeStopPriority) return
    auxiliaryRuntimeStopPriority = priority
    try {
      observeRegionalStop(auxiliaryRuntime.stop(shutdownReason))
    } catch {
      recordSynchronousRegionalStopFailure()
    }
  }

  const dispatchRegionalStops = (): void => {
    // Keep failures isolated: each dispatcher catches its own synchronous
    // failure so one regional runtime can never prevent the other from
    // receiving the same process-wide shutdown reason.
    dispatchRuntimeStop()
    dispatchAuxiliaryRuntimeStop()
  }

  const startBareLifecycleRelease = (): void => {
    if (bareReleaseAttempted || runtime !== undefined || lifecycle === undefined) return
    bareReleaseAttempted = true
    try {
      observeRegionalStop(lifecycle.stopAfterDrain(async () => undefined))
    } catch {
      recordSynchronousRegionalStopFailure()
    }
  }

  const waitForOperations = async (
    operationSets: ReadonlyArray<ReadonlySet<TrackedOperation>>
  ): Promise<void> => {
    while (true) {
      const current = operationSets.flatMap((operations) => [...operations])
      if (current.length === 0) {
        // Give callbacks triggered by the final settlement one turn to register
        // a follow-up operation before declaring the barrier drained.
        await Promise.resolve()
        if (operationSets.every((operations) => operations.size === 0)) return
        continue
      }
      await Promise.allSettled(current.map(({ completion }) => completion))
    }
  }

  const closeResource = async (
    close: () => PromiseLike<void> | void,
    failureCode: 'database_close_failed' | 'redis_close_failed'
  ): Promise<void> => {
    try {
      await close()
    } catch {
      markFatalOnce(failureCode)
    }
  }

  const runCleanup = async (): Promise<void> => {
    // A lifecycle acquired during a pending prepare must remain owned by that
    // prepare path. Only the caller's explicit startup settlement lets a bare
    // lifecycle release substitute for an absent runtime drain.
    dispatchRegionalStops()
    if (runtime === undefined) startBareLifecycleRelease()

    await waitForOperations([reconcileOperations, regionalStopOperations])
    if (reconcileFailed) markFatalOnce('reconcile_failed')
    if (regionalStopFailed) markFatalOnce('regional_stop_failed')

    // Database and Redis close independently. Redis must still be available
    // until all regional drains and scheduler reconciliations have settled.
    await closeResource(closeDatabase, 'database_close_failed')
    await closeResource(closeRedis, 'redis_close_failed')
  }

  const ensureCleanupPromise = (): Promise<void> => {
    if (cleanupPromise === undefined) {
      cleanupPromise = startupSettledBarrier.then(runCleanup)
    }
    return cleanupPromise
  }

  const bindTimer = (current: BoundTimer | undefined, clear: () => void): BoundTimer => {
    if (current !== undefined) {
      if (current.clear !== clear) throw coordinatorError('binding_conflict')
      return current
    }
    const timer = { clear, cleared: false }
    if (shutdownReason !== undefined) clearTimer(timer)
    return timer
  }

  const coordinator: NativeProcessCoordinator = {
    get shutdownReason() {
      return shutdownReason
    },
    get startupSettled() {
      return startupSettled
    },
    startupSignal: startupController.signal,
    assertStartupOpen: () => {
      if (shutdownReason !== undefined || startupController.signal.aborted) {
        throw coordinatorError('startup_closed')
      }
    },
    bindAuxiliaryRuntime: (nextRuntime) => {
      if (runtime === nextRuntime) throw coordinatorError('binding_conflict')
      if (auxiliaryRuntime !== undefined && auxiliaryRuntime !== nextRuntime) {
        throw coordinatorError('binding_conflict')
      }
      auxiliaryRuntime = nextRuntime
      dispatchAuxiliaryRuntimeStop()
    },
    bindAttemptHealthTimer: (clear) => {
      attemptHealthTimer = bindTimer(attemptHealthTimer, clear)
    },
    bindHeartbeatTimer: (clear) => {
      heartbeatTimer = bindTimer(heartbeatTimer, clear)
    },
    bindLifecycle: (nextLifecycle) => {
      if (lifecycle !== undefined && lifecycle !== nextLifecycle) {
        throw coordinatorError('binding_conflict')
      }
      lifecycle = nextLifecycle
      // Never release here. If prepare is in flight, only settleStartup() may
      // allow runCleanup() to choose a bare lifecycle release.
    },
    bindReconcileTimer: (clear) => {
      reconcileTimer = bindTimer(reconcileTimer, clear)
    },
    bindRuntime: (nextRuntime) => {
      if (auxiliaryRuntime === nextRuntime) throw coordinatorError('binding_conflict')
      if (runtime !== undefined && runtime !== nextRuntime) {
        throw coordinatorError('binding_conflict')
      }
      runtime = nextRuntime
      dispatchRuntimeStop()
    },
    requestShutdown: (reason, regionalStop) => {
      if (
        shutdownReason === undefined ||
        SHUTDOWN_PRIORITY[reason] > SHUTDOWN_PRIORITY[shutdownReason]
      ) {
        shutdownReason = reason
      }

      // Assign the process-global promise before aborting or invoking injected
      // callbacks: AbortSignal, timer clear and runtime.stop may all re-enter.
      const shutdown = ensureCleanupPromise()
      for (const operation of reconcileOperations) {
        shutdownReconcileOperations.add(operation)
      }
      if (regionalStop !== undefined) observeRegionalStop(regionalStop)
      const reasonToReport = strongestReason()
      if (reasonToReport !== 'signal') markFatalOnce(reasonToReport)
      if (!startupController.signal.aborted) {
        startupController.abort(coordinatorError('startup_closed'))
      }
      clearBoundTimers()
      dispatchRegionalStops()
      return shutdown
    },
    settleStartup: () => {
      if (startupSettled) return
      startupSettled = true
      resolveStartupSettled()
    },
    trackReconcile: (operation) => {
      const observed = observe(
        operation,
        reconcileOperations,
        (tracked) => {
          if (shutdownReconcileOperations.has(tracked)) reconcileFailed = true
        },
        (tracked) => shutdownReconcileOperations.delete(tracked)
      )
      if (shutdownReason !== undefined) shutdownReconcileOperations.add(observed)
    },
  }

  return Object.freeze(coordinator)
}
