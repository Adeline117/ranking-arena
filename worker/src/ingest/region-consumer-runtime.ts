import {
  createConsumedRegionAdmission,
  type AuthorizedConsumedRegionContext,
  type ConsumedRegionAdmission,
} from './consumed-region-context'
import type { RegionAuthorityLifecycle } from './region-authority-lifecycle'

export type RegionConsumerRuntimeState =
  | 'failed'
  | 'prepared'
  | 'running'
  | 'starting'
  | 'stopped'
  | 'stopping'

export type RegionConsumerRuntimeFailureCode =
  | 'authority_lost'
  | 'consumer_error'
  | 'prepare_failed'
  | 'run_failed'
  | 'start_failed'
  | 'stopped_unexpectedly'
  | 'stop_failed'

export type RegionConsumerStopReason =
  | 'authority_lost'
  | 'consumer_failed'
  | 'signal'
  | 'startup_failed'

export class RegionConsumerRuntimeError extends Error {
  readonly code: RegionConsumerRuntimeFailureCode

  constructor(code: RegionConsumerRuntimeFailureCode) {
    super(`[ingest-worker] region consumer runtime failed (${code})`)
    this.name = 'RegionConsumerRuntimeError'
    this.code = code
  }
}

export const REGION_CONSUMER_READY_TIMEOUT_MS = 15_000

/** The narrow BullMQ capability owned by the regional lifecycle. */
export interface RegionConsumer {
  cancelAllJobs(reason?: string): void
  close(force?: boolean): Promise<void>
  isRunning(): boolean
  on(event: 'error', listener: (error: Error) => void): unknown
  pause(doNotWaitActive?: boolean): Promise<void>
  run(): Promise<void>
  waitUntilReady(): Promise<unknown>
}

export interface PrepareRegionConsumerRuntimeOptions {
  createConsumers: (
    context: AuthorizedConsumedRegionContext,
    register: <TConsumer extends RegionConsumer>(consumer: TConsumer) => TConsumer
  ) => void
  executionRegion: string
  lifecycle: RegionAuthorityLifecycle
  onUnexpectedStop: (
    failure: RegionConsumerRuntimeError,
    shutdown: Promise<void>
  ) => Promise<void> | void
  readyTimeoutMs?: number
  startupSignal?: AbortSignal
}

export interface RegionConsumerRuntime {
  readonly failure: RegionConsumerRuntimeError | undefined
  readonly state: RegionConsumerRuntimeState
  start(): Promise<void>
  stop(reason: RegionConsumerStopReason): Promise<void>
}

function runtimeError(code: RegionConsumerRuntimeFailureCode): RegionConsumerRuntimeError {
  return new RegionConsumerRuntimeError(code)
}

function isRegionConsumer(value: unknown): value is RegionConsumer {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<Record<keyof RegionConsumer, unknown>>
  return (
    typeof candidate.cancelAllJobs === 'function' &&
    typeof candidate.close === 'function' &&
    typeof candidate.isRunning === 'function' &&
    typeof candidate.on === 'function' &&
    typeof candidate.pause === 'function' &&
    typeof candidate.run === 'function' &&
    typeof candidate.waitUntilReady === 'function'
  )
}

function settleCalls<T>(calls: ReadonlyArray<() => PromiseLike<T> | T>) {
  return Promise.allSettled(calls.map((call) => Promise.resolve().then(call)))
}

async function waitUntilReady(
  consumer: RegionConsumer,
  preparationSignal: AbortSignal,
  timeoutMs: number
): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  try {
    await Promise.race([
      consumer.waitUntilReady(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(runtimeError('prepare_failed')), timeoutMs)
        timeout.unref?.()
      }),
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(runtimeError('prepare_failed'))
        if (preparationSignal.aborted) abort()
        else preparationSignal.addEventListener('abort', abort, { once: true })
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    if (abort) preparationSignal.removeEventListener('abort', abort)
  }
}

/**
 * Own one complete regional consumer set and its authority release boundary.
 * Consumers remain inert until every one is ready and start() arms all run
 * loops. stop() closes admission synchronously and releases authority only
 * after every started loop has drained.
 */
export async function prepareRegionConsumerRuntime({
  createConsumers,
  executionRegion,
  lifecycle,
  onUnexpectedStop,
  readyTimeoutMs = REGION_CONSUMER_READY_TIMEOUT_MS,
  startupSignal,
}: PrepareRegionConsumerRuntimeOptions): Promise<RegionConsumerRuntime> {
  if (!Number.isSafeInteger(readyTimeoutMs) || readyTimeoutMs <= 0) {
    await lifecycle.stopAfterDrain(async () => undefined).catch(() => undefined)
    throw runtimeError('prepare_failed')
  }

  if (startupSignal?.aborted) {
    await lifecycle.stopAfterDrain(async () => undefined).catch(() => undefined)
    throw runtimeError('prepare_failed')
  }

  const preparationSignal = startupSignal
    ? AbortSignal.any([lifecycle.fence.signal, startupSignal])
    : lifecycle.fence.signal

  let admission: ConsumedRegionAdmission
  try {
    admission = createConsumedRegionAdmission(lifecycle, executionRegion)
  } catch {
    await lifecycle.stopAfterDrain(async () => undefined).catch(() => undefined)
    throw runtimeError('prepare_failed')
  }

  const prepared: RegionConsumer[] = []
  const registered = new WeakSet<object>()
  const runTasks: Promise<void>[] = []
  let acceptingRegistrations = true
  let drainErrored = false
  let failure: RegionConsumerRuntimeError | undefined
  let preparationErrored = false
  let preparationRunObserved = false
  let runAttempted = false
  let state: RegionConsumerRuntimeState = 'prepared'
  let stopPromise: Promise<void> | undefined
  let unexpectedStopNotified = false

  const register = <TConsumer extends RegionConsumer>(consumer: TConsumer): TConsumer => {
    if (
      !acceptingRegistrations ||
      !isRegionConsumer(consumer) ||
      registered.has(consumer as object)
    ) {
      throw runtimeError('prepare_failed')
    }
    registered.add(consumer as object)
    prepared.push(consumer)
    consumer.on('error', () => {
      if (state === 'stopped' || state === 'failed') return
      if (state === 'prepared') preparationErrored = true
      if (state === 'stopping') drainErrored = true
      if (state === 'running' || state === 'starting') {
        notifyFatal(runtimeError('consumer_error'), 'consumer_failed')
      }
    })
    if (preparationSignal.aborted) {
      preparationErrored = true
      throw runtimeError('prepare_failed')
    }
    try {
      if (consumer.isRunning()) {
        preparationRunObserved = true
        throw runtimeError('prepare_failed')
      }
    } catch {
      preparationRunObserved = true
      throw runtimeError('prepare_failed')
    }
    if (preparationSignal.aborted) {
      preparationErrored = true
      throw runtimeError('prepare_failed')
    }
    return consumer
  }

  const rollbackPrepared = async (): Promise<void> => {
    state = 'stopping'
    let cleanupFailed = false
    for (const consumer of prepared) {
      try {
        consumer.cancelAllJobs('regional consumer startup aborted')
      } catch {
        cleanupFailed = true
      }
    }
    if (preparationRunObserved) {
      const pauses = await settleCalls(prepared.map((consumer) => () => consumer.pause(true)))
      if (pauses.some((result) => result.status === 'rejected')) cleanupFailed = true
    }
    const closes = await settleCalls(
      [...prepared].reverse().map((consumer) => () => consumer.close(!preparationRunObserved))
    )
    if (cleanupFailed || drainErrored || closes.some((result) => result.status === 'rejected')) {
      throw runtimeError('stop_failed')
    }
  }

  try {
    if (preparationSignal.aborted) throw runtimeError('prepare_failed')
    const creationResult = createConsumers(admission.context, register)
    if (creationResult !== undefined) {
      // TypeScript permits an async callback where `void` is expected. Reject
      // it without awaiting an unbounded factory, but observe its eventual
      // outcome so a late throw cannot become an unhandled rejection.
      void Promise.resolve(creationResult).catch(() => undefined)
      throw runtimeError('prepare_failed')
    }
    acceptingRegistrations = false
    if (
      prepared.length === 0 ||
      lifecycle.state !== 'active' ||
      preparationErrored ||
      preparationSignal.aborted
    ) {
      throw runtimeError('prepare_failed')
    }
    await Promise.all(
      prepared.map((consumer) => waitUntilReady(consumer, preparationSignal, readyTimeoutMs))
    )
    for (const consumer of prepared) {
      try {
        if (consumer.isRunning()) preparationRunObserved = true
      } catch {
        preparationRunObserved = true
      }
    }
    if (
      lifecycle.state !== 'active' ||
      preparationErrored ||
      preparationRunObserved ||
      preparationSignal.aborted
    ) {
      throw runtimeError('prepare_failed')
    }
  } catch {
    acceptingRegistrations = false
    admission.close()
    await lifecycle.stopAfterDrain(rollbackPrepared).catch(() => undefined)
    state = 'failed'
    throw runtimeError('prepare_failed')
  }

  const consumers = Object.freeze([...prepared])

  const drain = async (reason: RegionConsumerStopReason, force: boolean): Promise<void> => {
    let drainFailed = drainErrored
    if (reason !== 'signal') {
      for (const consumer of consumers) {
        try {
          consumer.cancelAllJobs(reason)
        } catch {
          drainFailed = true
        }
      }
    }

    if (!force) {
      const pauses = await settleCalls(consumers.map((consumer) => () => consumer.pause(true)))
      if (pauses.some((result) => result.status === 'rejected')) drainFailed = true
    }

    const closes = await settleCalls(consumers.map((consumer) => () => consumer.close(force)))
    if (closes.some((result) => result.status === 'rejected')) drainFailed = true
    if (drainErrored) drainFailed = true
    if (drainFailed) throw runtimeError('stop_failed')

    if (!force) {
      // A rejected run loop may be why shutdown started. Waiting still proves
      // that every loop settled; close/error outcomes decide drain success.
      // Deliberately do not time this out yet: until every publisher is fenced,
      // expiring authority while an old callback can still write is less safe
      // than retaining authority and surfacing the already-fired fatal callback.
      await Promise.allSettled(runTasks)
    }
    if (drainErrored) drainFailed = true
    if (drainFailed) throw runtimeError('stop_failed')
  }

  const stop = (reason: RegionConsumerStopReason): Promise<void> => {
    admission.close()
    if (stopPromise) return stopPromise
    if (state === 'stopped') return Promise.resolve()

    const force = !runAttempted && !preparationRunObserved
    state = 'stopping'
    stopPromise = lifecycle
      .stopAfterDrain(() => drain(reason, force))
      .then(
        () => {
          state = 'stopped'
        },
        () => {
          state = 'failed'
          if (!failure) failure = runtimeError('stop_failed')
          throw failure
        }
      )
    return stopPromise
  }

  function notifyFatal(
    nextFailure: RegionConsumerRuntimeError,
    reason: RegionConsumerStopReason,
    includePrepared = false,
    includeStopping = false
  ): void {
    const canStop =
      state === 'running' ||
      state === 'starting' ||
      (includePrepared && state === 'prepared') ||
      (includeStopping && state === 'stopping')
    if (!canStop || unexpectedStopNotified) return
    unexpectedStopNotified = true
    if (!failure) failure = nextFailure
    admission.close()
    const shutdown = stop(reason)
    try {
      const notification = onUnexpectedStop(nextFailure, shutdown)
      void Promise.resolve(notification).catch(() => {
        console.error('[ingest-worker] region consumer fatal callback failed')
      })
    } catch {
      console.error('[ingest-worker] region consumer fatal callback failed')
    }
  }

  const start = async (): Promise<void> => {
    for (const consumer of consumers) {
      try {
        if (consumer.isRunning()) preparationRunObserved = true
      } catch {
        preparationRunObserved = true
      }
    }
    if (
      state !== 'prepared' ||
      preparationErrored ||
      preparationRunObserved ||
      lifecycle.state !== 'active'
    ) {
      admission.close()
      await stop('startup_failed').catch(() => undefined)
      throw runtimeError('start_failed')
    }

    state = 'starting'
    try {
      for (const consumer of consumers) {
        runAttempted = true
        const runTask = consumer.run()
        runTasks.push(runTask)
        void runTask.then(
          () => notifyFatal(runtimeError('stopped_unexpectedly'), 'consumer_failed'),
          () => notifyFatal(runtimeError('run_failed'), 'consumer_failed')
        )
        if (state !== 'starting') throw runtimeError('start_failed')
      }
      await Promise.resolve()
      if (
        state !== 'starting' ||
        lifecycle.state !== 'active' ||
        consumers.some((consumer) => !consumer.isRunning())
      ) {
        throw runtimeError('start_failed')
      }
      admission.open()
      state = 'running'
    } catch {
      admission.close()
      if (!failure) failure = runtimeError('start_failed')
      await stop('startup_failed').catch(() => undefined)
      throw failure
    }
  }

  let authorityLossCancellationAttempted = false
  const stopOnAuthorityLoss = () => {
    // release() aborts the fence intentionally while the lifecycle is still
    // stopping. Only a lifecycle that has already classified the abort as a
    // real loss may escalate an in-flight graceful drain.
    if (lifecycle.state !== 'lost') return

    if (state === 'stopping' && !authorityLossCancellationAttempted) {
      admission.close()
      authorityLossCancellationAttempted = true
      for (const consumer of consumers) {
        try {
          consumer.cancelAllJobs('authority_lost')
        } catch {
          drainErrored = true
        }
      }
    }

    notifyFatal(runtimeError('authority_lost'), 'authority_lost', true, true)
  }
  lifecycle.fence.signal.addEventListener('abort', stopOnAuthorityLoss, { once: true })
  if (lifecycle.fence.signal.aborted) {
    stopOnAuthorityLoss()
    await stop('authority_lost').catch(() => undefined)
    throw runtimeError('prepare_failed')
  }
  if (preparationSignal.aborted) {
    await stop('startup_failed').catch(() => undefined)
    throw runtimeError('prepare_failed')
  }

  return Object.freeze({
    get failure() {
      return failure
    },
    get state() {
      return state
    },
    start,
    stop,
  })
}
