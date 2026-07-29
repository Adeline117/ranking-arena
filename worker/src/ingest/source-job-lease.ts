import { randomUUID } from 'node:crypto'

/**
 * Keep this below the bulk worker's 5-minute stalled check. If a process dies,
 * BullMQ can recover the job after the orphaned source lease has expired
 * instead of mistaking its own dead predecessor for a live duplicate.
 */
export const SOURCE_JOB_LEASE_TTL_MS = 4 * 60_000
export const SOURCE_JOB_LEASE_RENEW_MS = 30_000
export const SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS = 15_000

const RENEW_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0
`

const DELETE_IF_OWNER = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`

export interface SourceJobLeaseResult<T> {
  coalesced: boolean
  value?: T
}

export interface SourceJobRedis {
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    condition: 'NX'
  ): Promise<string | null>
  eval(script: string, keyCount: 1, key: string, ...args: string[]): Promise<unknown>
}

interface SourceJobLeaseOptions<T> {
  redis: SourceJobRedis
  lane: string
  sourceSlug: string
  run: (signal: AbortSignal) => Promise<T>
  signal?: AbortSignal
  failClosedOnLeaseLoss?: boolean
  onLeaseError?: (error: unknown) => void
}

function leaseKey(lane: string, sourceSlug: string): string {
  if (!/^[a-z0-9:_-]+$/i.test(lane) || !/^[a-z0-9_-]+$/i.test(sourceSlug)) {
    throw new Error(`[ingest] unsafe source-job lease identity: ${lane}/${sourceSlug}`)
  }
  return `arena:ingest:source-job-lease:${lane}:${sourceSlug}`
}

function boundedLeaseCommand<T>(command: () => Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`[ingest] source-job lease ${operation} timed out`))
    }, SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS)
    ;(timeout as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.()

    let pending: Promise<T>
    try {
      pending = command()
    } catch (error) {
      settled = true
      clearTimeout(timeout)
      reject(error)
      return
    }

    // Attach both handlers immediately. A shared ioredis command may settle
    // long after our bounded wait; observing that late outcome prevents an
    // unhandled rejection without allowing it to change the fenced result.
    void pending.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(error)
      }
    )
  })
}

/**
 * Coalesce duplicate recovered scheduler iterations for one source and lane.
 *
 * BullMQ correctly recovers every stalled iteration after a worker restart.
 * When several old source iterations exist for the same tier, however, they
 * can all become active together: the in-process persistent-profile lane then
 * serializes the browser sessions, but the duplicates still occupy worker
 * slots and eventually repeat the same crawl. This Redis lease is shared by
 * the native region worker and its failover worker, so exactly one current
 * owner per source+tier survives that recovery wave.
 */
export async function withSourceJobLease<T>({
  redis,
  lane,
  sourceSlug,
  run,
  signal,
  failClosedOnLeaseLoss = false,
  onLeaseError = (error) => console.error('[ingest] source-job lease error:', error),
}: SourceJobLeaseOptions<T>): Promise<SourceJobLeaseResult<T>> {
  const key = leaseKey(lane, sourceSlug)
  const token = randomUUID()
  const reportLeaseError = (error: unknown) => {
    try {
      onLeaseError(error)
    } catch {
      // Observability must not replace the fenced lease outcome.
    }
  }
  const cleanupUncertainAcquire = async () => {
    try {
      // ioredis preserves command order on one shared connection. If SET
      // eventually reaches Redis after our local deadline, this token-fenced
      // DELETE follows it and removes only that uncertain owner.
      await boundedLeaseCommand(
        () => redis.eval(DELETE_IF_OWNER, 1, key, token),
        `uncertain acquire cleanup: ${lane}/${sourceSlug}`
      )
    } catch (error) {
      reportLeaseError(error)
    }
  }
  let acquired: string | null
  try {
    acquired = await boundedLeaseCommand(
      () => redis.set(key, token, 'PX', SOURCE_JOB_LEASE_TTL_MS, 'NX'),
      `acquire: ${lane}/${sourceSlug}`
    )
  } catch (error) {
    await cleanupUncertainAcquire()
    throw error
  }
  if (acquired === null) return { coalesced: true }
  if (acquired !== 'OK') {
    await cleanupUncertainAcquire()
    throw new Error(
      `[ingest] source-job lease acquire returned an invalid result: ${lane}/${sourceSlug}`
    )
  }

  const leaseAbort = new AbortController()
  const runSignal = signal ? AbortSignal.any([signal, leaseAbort.signal]) : leaseAbort.signal
  const abortLease = (error: unknown) => {
    const reason =
      error instanceof Error
        ? error
        : new Error(`[ingest] source-job lease renewal failed: ${lane}/${sourceSlug}`)
    if (leaseAbort.signal.aborted) return
    leaseAbort.abort(reason)
    reportLeaseError(reason)
  }
  let renewalRunning = false
  let renewalPromise: Promise<void> | null = null
  const renewal = setInterval(() => {
    if (renewalRunning || leaseAbort.signal.aborted) return
    renewalRunning = true
    renewalPromise = boundedLeaseCommand(
      () => redis.eval(RENEW_IF_OWNER, 1, key, token, String(SOURCE_JOB_LEASE_TTL_MS)),
      `renewal: ${lane}/${sourceSlug}`
    )
      .then((renewed) => {
        if (renewed !== 1) {
          abortLease(new Error(`[ingest] source-job lease ownership lost: ${lane}/${sourceSlug}`))
        }
      })
      .catch(abortLease)
      .finally(() => {
        renewalRunning = false
        renewalPromise = null
      })
  }, SOURCE_JOB_LEASE_RENEW_MS)
  ;(renewal as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()

  let value!: T
  let runFailed = false
  let runFailure: unknown
  try {
    value = await run(runSignal)
  } catch (error) {
    runFailed = true
    runFailure = error
  }

  clearInterval(renewal)
  const pendingRenewal = renewalPromise
  if (pendingRenewal !== null) await pendingRenewal
  try {
    await boundedLeaseCommand(
      () => redis.eval(DELETE_IF_OWNER, 1, key, token),
      `cleanup: ${lane}/${sourceSlug}`
    )
  } catch (error) {
    // The bounded TTL is the recovery path. Do not turn a successful crawl
    // into a BullMQ retry merely because best-effort lease cleanup failed.
    reportLeaseError(error)
  }

  if (runFailed) throw runFailure
  if (failClosedOnLeaseLoss && leaseAbort.signal.aborted) throw leaseAbort.signal.reason
  return { coalesced: false, value }
}
