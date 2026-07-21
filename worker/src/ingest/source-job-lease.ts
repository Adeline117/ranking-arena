import { randomUUID } from 'node:crypto'

/**
 * Keep this below the bulk worker's 5-minute stalled check. If a process dies,
 * BullMQ can recover the job after the orphaned source lease has expired
 * instead of mistaking its own dead predecessor for a live duplicate.
 */
export const SOURCE_JOB_LEASE_TTL_MS = 4 * 60_000
export const SOURCE_JOB_LEASE_RENEW_MS = 30_000

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
  run: () => Promise<T>
  onLeaseError?: (error: unknown) => void
}

function leaseKey(lane: string, sourceSlug: string): string {
  if (!/^[a-z0-9:_-]+$/i.test(lane) || !/^[a-z0-9_-]+$/i.test(sourceSlug)) {
    throw new Error(`[ingest] unsafe source-job lease identity: ${lane}/${sourceSlug}`)
  }
  return `arena:ingest:source-job-lease:${lane}:${sourceSlug}`
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
  onLeaseError = (error) => console.error('[ingest] source-job lease error:', error),
}: SourceJobLeaseOptions<T>): Promise<SourceJobLeaseResult<T>> {
  const key = leaseKey(lane, sourceSlug)
  const token = randomUUID()
  const acquired = await redis.set(key, token, 'PX', SOURCE_JOB_LEASE_TTL_MS, 'NX')
  if (acquired !== 'OK') return { coalesced: true }

  let renewalRunning = false
  const renewal = setInterval(() => {
    if (renewalRunning) return
    renewalRunning = true
    void redis
      .eval(RENEW_IF_OWNER, 1, key, token, String(SOURCE_JOB_LEASE_TTL_MS))
      .then((renewed) => {
        if (renewed !== 1) {
          onLeaseError(new Error(`[ingest] source-job lease ownership lost: ${lane}/${sourceSlug}`))
        }
      })
      .catch(onLeaseError)
      .finally(() => {
        renewalRunning = false
      })
  }, SOURCE_JOB_LEASE_RENEW_MS)
  ;(renewal as ReturnType<typeof setInterval> & { unref?: () => void }).unref?.()

  try {
    return { coalesced: false, value: await run() }
  } finally {
    clearInterval(renewal)
    try {
      await redis.eval(DELETE_IF_OWNER, 1, key, token)
    } catch (error) {
      // The bounded TTL is the recovery path. Do not turn a successful crawl
      // into a BullMQ retry merely because best-effort lease cleanup failed.
      onLeaseError(error)
    }
  }
}
