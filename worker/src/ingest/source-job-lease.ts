import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * Keep this below the bulk worker's 5-minute stalled check. If a process dies,
 * BullMQ can recover the job after the orphaned source lease has expired
 * instead of mistaking its own dead predecessor for a live duplicate.
 */
export const SOURCE_JOB_LEASE_TTL_MS = 4 * 60_000
export const SOURCE_JOB_LEASE_RENEW_MS = 30_000
export const SOURCE_JOB_LEASE_COMMAND_TIMEOUT_MS = 15_000
export const SOURCE_JOB_LEASE_PROVENANCE_CONTRACT =
  'arena.ingest.source-job-lease-provenance@1' as const

class SafeSourceLeaseError extends Error {}

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

export interface SourceJobLeaseProof {
  readonly contract: typeof SOURCE_JOB_LEASE_PROVENANCE_CONTRACT
  readonly leaseId: string
  readonly lane: string
  readonly scopeId: string
  readonly ownerTokenSha256: string
}

export interface SourceJobLeaseAuthority {
  readonly proof: SourceJobLeaseProof
  assertOwned(): void
  renew(): Promise<void>
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
  scopeId: string
  run: (
    proof: SourceJobLeaseProof,
    signal: AbortSignal,
    authority: SourceJobLeaseAuthority
  ) => Promise<T>
  signal?: AbortSignal
  failClosedOnLeaseLoss?: boolean
  onLeaseError?: (error: unknown) => void
}

function leaseKey(lane: string, scopeId: string): string {
  if (!/^[a-z0-9][a-z0-9:_-]{0,127}$/.test(lane) || !/^[a-z0-9][a-z0-9_-]{0,255}$/.test(scopeId)) {
    throw new Error(`[ingest] unsafe source-job lease identity: ${lane}/${scopeId}`)
  }
  return `arena:ingest:source-job-lease:${lane}:${scopeId}`
}

function boundedLeaseCommand<T>(command: () => Promise<T>, operation: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new SafeSourceLeaseError(`[ingest] source-job lease ${operation} timed out`))
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

function safeLeaseCommandError(
  error: unknown,
  operation: string,
  lane: string,
  scopeId: string
): Error {
  if (error instanceof SafeSourceLeaseError) {
    return error
  }
  return new Error(`[ingest] source-job lease ${operation} failed: ${lane}/${scopeId}`)
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
  scopeId,
  run,
  signal,
  failClosedOnLeaseLoss = false,
  onLeaseError = (error) => console.error('[ingest] source-job lease error:', error),
}: SourceJobLeaseOptions<T>): Promise<SourceJobLeaseResult<T>> {
  const key = leaseKey(lane, scopeId)
  const leaseId = randomUUID()
  // This token is deliberately independent from the public lease UUID and is
  // never returned, logged, or placed on a provenance object.
  const ownerToken = randomBytes(32).toString('base64url')
  const proof: SourceJobLeaseProof = Object.freeze({
    contract: SOURCE_JOB_LEASE_PROVENANCE_CONTRACT,
    leaseId,
    lane,
    scopeId,
    ownerTokenSha256: createHash('sha256').update(ownerToken, 'utf8').digest('hex'),
  })
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
        () => redis.eval(DELETE_IF_OWNER, 1, key, ownerToken),
        `uncertain acquire cleanup: ${lane}/${scopeId}`
      )
    } catch (error) {
      reportLeaseError(safeLeaseCommandError(error, 'uncertain acquire cleanup', lane, scopeId))
    }
  }
  let acquired: string | null
  try {
    acquired = await boundedLeaseCommand(
      () => redis.set(key, ownerToken, 'PX', SOURCE_JOB_LEASE_TTL_MS, 'NX'),
      `acquire: ${lane}/${scopeId}`
    )
  } catch (error) {
    await cleanupUncertainAcquire()
    throw safeLeaseCommandError(error, 'acquire', lane, scopeId)
  }
  if (acquired === null) return { coalesced: true }
  if (acquired !== 'OK') {
    await cleanupUncertainAcquire()
    throw new Error(
      `[ingest] source-job lease acquire returned an invalid result: ${lane}/${scopeId}`
    )
  }

  const leaseAbort = new AbortController()
  const runSignal = signal ? AbortSignal.any([signal, leaseAbort.signal]) : leaseAbort.signal
  let leaseClosed = false
  const abortLease = (error: unknown) => {
    const reason =
      error instanceof Error
        ? error
        : new Error(`[ingest] source-job lease renewal failed: ${lane}/${scopeId}`)
    if (leaseAbort.signal.aborted) return
    leaseAbort.abort(reason)
    reportLeaseError(reason)
  }
  let renewalRunning = false
  let renewalPromise: Promise<void> | null = null
  const assertOwned = () => {
    if (leaseClosed)
      throw new Error(`[ingest] source-job lease authority is closed: ${lane}/${scopeId}`)
    if (leaseAbort.signal.aborted) throw leaseAbort.signal.reason
  }
  const renewOwned = (): Promise<void> => {
    try {
      assertOwned()
    } catch (error) {
      return Promise.reject(error)
    }
    if (renewalPromise !== null) return renewalPromise
    renewalRunning = true
    renewalPromise = boundedLeaseCommand(
      () => redis.eval(RENEW_IF_OWNER, 1, key, ownerToken, String(SOURCE_JOB_LEASE_TTL_MS)),
      `renewal: ${lane}/${scopeId}`
    )
      .then((renewed) => {
        if (renewed !== 1) {
          throw new SafeSourceLeaseError(
            `[ingest] source-job lease ownership lost: ${lane}/${scopeId}`
          )
        }
      })
      .catch((error) => {
        abortLease(safeLeaseCommandError(error, 'renewal', lane, scopeId))
        throw leaseAbort.signal.reason
      })
      .finally(() => {
        renewalRunning = false
        renewalPromise = null
      })
    return renewalPromise
  }
  const authority: SourceJobLeaseAuthority = Object.freeze({
    proof,
    assertOwned,
    renew: renewOwned,
  })
  const renewal = setInterval(() => {
    if (renewalRunning || leaseAbort.signal.aborted) return
    void renewOwned().catch(() => undefined)
  }, SOURCE_JOB_LEASE_RENEW_MS)
  ;(renewal as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()

  let value!: T
  let runFailed = false
  let runFailure: unknown
  try {
    value = await run(proof, runSignal, authority)
  } catch (error) {
    runFailed = true
    runFailure = error
  }

  leaseClosed = true
  clearInterval(renewal)
  const pendingRenewal = renewalPromise as Promise<void> | null
  if (pendingRenewal !== null) await pendingRenewal.catch(() => undefined)
  try {
    await boundedLeaseCommand(
      () => redis.eval(DELETE_IF_OWNER, 1, key, ownerToken),
      `cleanup: ${lane}/${scopeId}`
    )
  } catch (error) {
    // The bounded TTL is the recovery path. Do not turn a successful crawl
    // into a BullMQ retry merely because best-effort lease cleanup failed.
    reportLeaseError(safeLeaseCommandError(error, 'cleanup', lane, scopeId))
  }

  if (runFailed) throw runFailure
  if (failClosedOnLeaseLoss && leaseAbort.signal.aborted) throw leaseAbort.signal.reason
  return { coalesced: false, value }
}
