import { config } from 'dotenv'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const RELEASE = /^[0-9a-f]{64}$/
const NODE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const REQUIRED_REGIONS = ['local']
const LEGACY_LOCAL_REGIONS = ['local', 'vps_jp']
const MODERN_BASE_KEYS = [
  'attempt_bound_capture',
  'node',
  'pid',
  'regions',
  'release_id',
  'sha',
  'ts',
]
const MODERN_WITH_DISK_KEYS = [...MODERN_BASE_KEYS, 'disk'].sort()
const LEGACY_BASE_KEYS = ['node', 'pid', 'regions', 'sha', 'ts']
const LEGACY_WITH_DISK_KEYS = [...LEGACY_BASE_KEYS, 'disk'].sort()

interface RedisRosterClient {
  disconnect(reconnect?: boolean): void
  hget(key: string, field: string): Promise<string | null>
  hgetall(key: string): Promise<Record<string, string>>
}

export interface ExpectedLocalHeartbeat {
  pid: number
  sha: string
  releaseId: string
  nodeId: string
  notBeforeMs: number
}

interface ExistingLocalHeartbeat {
  sha: string
  releaseId: string
}

export interface ExistingLocalNodeIdentity {
  nodeId: string
  heartbeatPid: number
}

function hasExactPayloadKeys(record: Record<string, unknown>, legacy = false): boolean {
  const keys = Object.keys(record).sort()
  const base = legacy ? LEGACY_BASE_KEYS : MODERN_BASE_KEYS
  const withDisk = legacy ? LEGACY_WITH_DISK_KEYS : MODERN_WITH_DISK_KEYS
  return (
    JSON.stringify(keys) === JSON.stringify(base) ||
    JSON.stringify(keys) === JSON.stringify(withDisk)
  )
}

function hasValidDisk(record: Record<string, unknown>): boolean {
  return (
    !('disk' in record) ||
    (typeof record.disk === 'number' &&
      Number.isInteger(record.disk) &&
      record.disk >= 0 &&
      record.disk <= 100)
  )
}

function parseRosterPayload(raw: string | null, legacy = false): Record<string, unknown> {
  if (!raw) throw new Error('fresh roster field is absent')
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error('roster field is not JSON')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('roster payload is not an object')
  }
  const record = payload as Record<string, unknown>
  if (!hasExactPayloadKeys(record, legacy)) {
    throw new Error('roster payload keys are not exact')
  }
  if (!hasValidDisk(record)) throw new Error('roster disk value is malformed')
  return record
}

function isFreshTimestamp(value: unknown, now: number, notBeforeMs?: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    (notBeforeMs === undefined || value >= notBeforeMs) &&
    value <= now + 5_000 &&
    now - value <= 120_000
  )
}

function hasExpectedRegions(value: unknown, legacy: boolean): boolean {
  const encoded = JSON.stringify(value)
  if (encoded === JSON.stringify(REQUIRED_REGIONS)) return true
  return legacy && encoded === JSON.stringify(LEGACY_LOCAL_REGIONS)
}

export function validateLocalHeartbeatPayload(
  raw: string | null,
  expected: ExpectedLocalHeartbeat,
  now = Date.now()
): void {
  const record = parseRosterPayload(raw)
  if (
    record.pid !== expected.pid ||
    record.node !== expected.nodeId ||
    record.sha !== expected.sha ||
    record.release_id !== expected.releaseId ||
    record.attempt_bound_capture !== true ||
    JSON.stringify(record.regions) !== JSON.stringify(REQUIRED_REGIONS) ||
    !isFreshTimestamp(record.ts, now, expected.notBeforeMs)
  ) {
    throw new Error('roster identity or freshness is not exact')
  }
}

/**
 * Resolve the logical identity of the already-running local worker from shared
 * Redis, not from PM2's inherited environment. dotenv is loaded by the child
 * worker after PM2 starts it, so pm2_env is not authoritative for WORKER_NODE_ID.
 */
export function discoverExistingLocalNode(
  roster: Record<string, string>,
  expected: ExistingLocalHeartbeat,
  now = Date.now()
): ExistingLocalNodeIdentity {
  const legacy = expected.releaseId === 'unknown'
  const matches: ExistingLocalNodeIdentity[] = []
  for (const [field, raw] of Object.entries(roster)) {
    try {
      const record = parseRosterPayload(raw, legacy)
      if (
        NODE_ID.test(field) &&
        record.node === field &&
        typeof record.pid === 'number' &&
        Number.isSafeInteger(record.pid) &&
        record.pid > 0 &&
        record.sha === expected.sha &&
        (legacy ||
          (record.release_id === expected.releaseId && record.attempt_bound_capture === true)) &&
        hasExpectedRegions(record.regions, legacy) &&
        isFreshTimestamp(record.ts, now)
      ) {
        matches.push({ nodeId: field, heartbeatPid: record.pid })
      }
    } catch {
      // Unrelated or malformed fleet entries are not evidence for this process.
    }
  }
  if (matches.length !== 1) {
    throw new Error(`expected one exact existing local roster owner, found ${matches.length}`)
  }
  return matches[0]
}

function parsePositiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`[local-heartbeat-proof] ${label} is malformed`)
  }
  return parsed
}

function parseExpected(args: string[]): ExpectedLocalHeartbeat {
  const [pidRaw, sha, releaseId, nodeId, notBeforeRaw, ...extra] = args
  const pid = parsePositiveInteger(pidRaw, 'pid')
  const notBeforeMs = parsePositiveInteger(notBeforeRaw, 'not-before time')
  if (
    extra.length !== 0 ||
    !SHA.test(sha ?? '') ||
    !RELEASE.test(releaseId ?? '') ||
    !NODE_ID.test(nodeId ?? '')
  ) {
    throw new Error('[local-heartbeat-proof] expected identity arguments are malformed')
  }
  return { pid, sha, releaseId, nodeId, notBeforeMs }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      }),
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

async function main(): Promise<void> {
  config({ path: resolve(process.cwd(), 'worker', '.env'), override: false, quiet: true })
  const [{ getConnection }, { WORKER_ROSTER_KEY }] = await Promise.all([
    import('./src/connection'),
    import('./src/ingest/heartbeat'),
  ])
  const redis: RedisRosterClient = getConnection()
  const args = process.argv.slice(2)
  try {
    if (args[0] === '--discover-existing') {
      if (
        args.length !== 3 ||
        !SHA.test(args[1] ?? '') ||
        !((args[2] ?? '') === 'unknown' || RELEASE.test(args[2] ?? ''))
      ) {
        throw new Error('[local-heartbeat-proof] discovery arguments are malformed')
      }
      const roster = await withTimeout(redis.hgetall(WORKER_ROSTER_KEY), 5_000, 'Redis HGETALL')
      const identity = discoverExistingLocalNode(roster, {
        sha: args[1],
        releaseId: args[2],
      })
      console.log(`ARENA_LOCAL_EXISTING_ROSTER\t${identity.nodeId}\t${identity.heartbeatPid}`)
      return
    }

    const expected = parseExpected(args)
    const deadline = Date.now() + 90_000
    let lastError = 'no roster observation'
    while (Date.now() < deadline) {
      try {
        const raw = await withTimeout(
          redis.hget(WORKER_ROSTER_KEY, expected.nodeId),
          5_000,
          'Redis HGET'
        )
        validateLocalHeartbeatPayload(raw, expected)
        console.log('[local-heartbeat-proof] exact fresh Redis roster identity ready')
        return
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000))
    }
    throw new Error(`[local-heartbeat-proof] ${lastError}`)
  } finally {
    redis.disconnect(false)
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
