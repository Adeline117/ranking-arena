import { config } from 'dotenv'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/
const RELEASE = /^[0-9a-f]{64}$/
const SG_NODE_ID = 'vps_sg'
const SG_REGIONS = ['vps_sg']
export const SG_ROSTER_READY_TOKEN = '[sg-heartbeat-proof] exact fresh Redis roster identity ready'
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
const LEGACY_KEY_VARIANTS = [
  LEGACY_BASE_KEYS,
  [...LEGACY_BASE_KEYS, 'disk'].sort(),
  [...LEGACY_BASE_KEYS, 'attempt_bound_capture'].sort(),
  [...LEGACY_BASE_KEYS, 'attempt_bound_capture', 'disk'].sort(),
]

export interface RedisRosterClient {
  disconnect(reconnect?: boolean): void
  hget(key: string, field: string): Promise<string | null>
  on(event: string, listener: () => void): void
}

class ControlledSgProofError extends Error {}
class SgHeartbeatValidationError extends ControlledSgProofError {}

export interface ExpectedSgHeartbeat {
  mode: 'candidate' | 'rollback'
  sha: string
  releaseId: string
  notBeforeMs: number
  pm2Pid: number
}

export interface ProcessTreeReader {
  isAlive(pid: number): boolean
  parentPid(pid: number): number
}

function hasExactKeys(record: Record<string, unknown>, legacy: boolean): boolean {
  const keys = Object.keys(record).sort()
  if (legacy) {
    return LEGACY_KEY_VARIANTS.some((variant) => JSON.stringify(keys) === JSON.stringify(variant))
  }
  return (
    JSON.stringify(keys) === JSON.stringify(MODERN_BASE_KEYS) ||
    JSON.stringify(keys) === JSON.stringify(MODERN_WITH_DISK_KEYS)
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

function parsePayload(
  raw: string | null,
  allowLegacy: boolean
): { record: Record<string, unknown>; legacy: boolean } {
  if (!raw) throw new SgHeartbeatValidationError('fresh SG roster field is absent')
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new SgHeartbeatValidationError('SG roster field is not JSON')
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SgHeartbeatValidationError('SG roster payload is not an object')
  }

  const record = payload as Record<string, unknown>
  const modern = hasExactKeys(record, false)
  const legacy = allowLegacy && hasExactKeys(record, true)
  if (!modern && !legacy) {
    throw new SgHeartbeatValidationError('SG roster payload keys are not exact')
  }
  if (!hasValidDisk(record)) {
    throw new SgHeartbeatValidationError('SG roster disk value is malformed')
  }
  if (
    legacy &&
    'attempt_bound_capture' in record &&
    typeof record.attempt_bound_capture !== 'boolean'
  ) {
    throw new SgHeartbeatValidationError('SG legacy roster capture flag is malformed')
  }
  return { record, legacy }
}

function isFreshTimestamp(value: unknown, expected: ExpectedSgHeartbeat, now: number): boolean {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= expected.notBeforeMs &&
    value <= now + 5_000 &&
    now - value <= 120_000
  )
}

/** Validate identity and freshness without ever returning or logging the payload. */
export function validateSgHeartbeatPayload(
  raw: string | null,
  expected: ExpectedSgHeartbeat,
  now = Date.now()
): number {
  const allowLegacy = expected.mode === 'rollback'
  const { record, legacy } = parsePayload(raw, allowLegacy)
  if (
    record.node !== SG_NODE_ID ||
    JSON.stringify(record.regions) !== JSON.stringify(SG_REGIONS) ||
    record.sha !== expected.sha ||
    typeof record.pid !== 'number' ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    !isFreshTimestamp(record.ts, expected, now)
  ) {
    throw new SgHeartbeatValidationError('SG roster identity or freshness is not exact')
  }
  if (
    !legacy &&
    (record.release_id !== expected.releaseId || typeof record.attempt_bound_capture !== 'boolean')
  ) {
    throw new SgHeartbeatValidationError('SG roster release identity is not exact')
  }
  if ('attempt_bound_capture' in record && record.attempt_bound_capture !== true) {
    throw new SgHeartbeatValidationError('SG roster attempt-bound capture is not enabled')
  }
  return record.pid
}

function defaultProcessTreeReader(): ProcessTreeReader {
  return {
    isAlive(pid) {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM'
      }
    },
    parentPid(pid) {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8').trim()
      const commandEnd = stat.lastIndexOf(') ')
      if (commandEnd < 0) throw new SgHeartbeatValidationError('process stat is malformed')
      const fields = stat.slice(commandEnd + 2).split(/\s+/)
      const parent = Number(fields[1])
      if (!Number.isSafeInteger(parent) || parent < 0) {
        throw new SgHeartbeatValidationError('process parent PID is malformed')
      }
      return parent
    },
  }
}

/** Require the heartbeat writer to be the exact PM2 process or its live child. */
export function proveSgHeartbeatProcessTree(
  pm2Pid: number,
  heartbeatPid: number,
  reader: ProcessTreeReader = defaultProcessTreeReader()
): void {
  if (!Number.isSafeInteger(pm2Pid) || pm2Pid <= 0 || !reader.isAlive(pm2Pid)) {
    throw new SgHeartbeatValidationError('SG PM2 PID is not live')
  }
  if (!Number.isSafeInteger(heartbeatPid) || heartbeatPid <= 0 || !reader.isAlive(heartbeatPid)) {
    throw new SgHeartbeatValidationError('SG heartbeat PID is not live')
  }

  let current = heartbeatPid
  const visited = new Set<number>()
  for (let depth = 0; depth < 64; depth += 1) {
    if (current === pm2Pid) return
    if (current <= 1 || visited.has(current)) break
    visited.add(current)
    current = reader.parentPid(current)
  }
  throw new SgHeartbeatValidationError('SG heartbeat PID is outside the PM2 process tree')
}

function positiveInteger(value: string | undefined, label: string): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ControlledSgProofError(`[sg-heartbeat-proof] ${label} is malformed`)
  }
  return parsed
}

function parseExpected(args: string[]): ExpectedSgHeartbeat {
  const [modeArg, sha, releaseId, notBeforeRaw, pm2PidRaw, ...extra] = args
  const mode =
    modeArg === '--candidate' ? 'candidate' : modeArg === '--rollback' ? 'rollback' : null
  if (
    !mode ||
    extra.length !== 0 ||
    !SHA.test(sha ?? '') ||
    !(RELEASE.test(releaseId ?? '') || (mode === 'rollback' && releaseId === 'unknown'))
  ) {
    throw new ControlledSgProofError(
      '[sg-heartbeat-proof] expected identity arguments are malformed'
    )
  }
  return {
    mode,
    sha: sha as string,
    releaseId: releaseId as string,
    notBeforeMs: positiveInteger(notBeforeRaw, 'not-before time'),
    pm2Pid: positiveInteger(pm2PidRaw, 'PM2 PID'),
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Redis HGET timed out')), timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

export interface SgRosterVerificationOptions {
  deadlineMs?: number
  hgetTimeoutMs?: number
  now?: () => number
  processTreeReader?: ProcessTreeReader
  sleep?: (delayMs: number) => Promise<void>
}

/**
 * Poll the shared roster through the same HGET → payload → process ancestry
 * chain used by the CLI. Only this function can return the deploy-ready token;
 * Redis/client failures are collapsed to a fixed message so credentials cannot
 * cross the process boundary through an attacker-controlled Error string.
 */
export async function verifySgHeartbeatRoster(
  expected: ExpectedSgHeartbeat,
  redis: RedisRosterClient,
  options: SgRosterVerificationOptions = {}
): Promise<string> {
  const deadlineMs = options.deadlineMs ?? 90_000
  const hgetTimeoutMs = options.hgetTimeoutMs ?? 5_000
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 90_000) {
    throw new ControlledSgProofError('[sg-heartbeat-proof] deadline is malformed')
  }
  if (!Number.isSafeInteger(hgetTimeoutMs) || hgetTimeoutMs <= 0 || hgetTimeoutMs > 5_000) {
    throw new ControlledSgProofError('[sg-heartbeat-proof] HGET timeout is malformed')
  }

  const now = options.now ?? Date.now
  const processTreeReader = options.processTreeReader ?? defaultProcessTreeReader()
  const sleep =
    options.sleep ??
    ((delayMs: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs)))
  const deadline = now() + deadlineMs
  let lastError = 'no roster observation'

  while (now() < deadline) {
    try {
      const raw = await withTimeout(redis.hget('arena:worker:roster', SG_NODE_ID), hgetTimeoutMs)
      const heartbeatPid = validateSgHeartbeatPayload(raw, expected, now())
      proveSgHeartbeatProcessTree(expected.pm2Pid, heartbeatPid, processTreeReader)
      return SG_ROSTER_READY_TOKEN
    } catch (error) {
      lastError =
        error instanceof SgHeartbeatValidationError
          ? error.message
          : 'Redis roster read did not produce exact evidence'
    }
    await sleep(1_000)
  }

  throw new ControlledSgProofError(`[sg-heartbeat-proof] ${lastError}`)
}

async function main(): Promise<void> {
  const expected = parseExpected(process.argv.slice(2))
  config({ path: resolve(process.cwd(), 'worker', '.env'), override: false, quiet: true })
  const redisUrl = process.env.REDIS_URL
  if (!redisUrl) {
    throw new ControlledSgProofError('[sg-heartbeat-proof] Redis configuration is unavailable')
  }
  const { default: IORedis } = await import('ioredis')
  let redis: RedisRosterClient
  try {
    redis = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      tls: redisUrl.startsWith('rediss://') ? {} : undefined,
    })
  } catch {
    throw new ControlledSgProofError('[sg-heartbeat-proof] Redis client initialization failed')
  }
  redis.on('error', () => {})
  try {
    console.log(await verifySgHeartbeatRoster(expected, redis))
  } finally {
    try {
      redis.disconnect(false)
    } catch {
      // The proof result is already determined; never expose client internals.
    }
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    // Validation failures are intentionally terse: never echo Redis payloads or env.
    console.error(
      error instanceof ControlledSgProofError
        ? error.message
        : '[sg-heartbeat-proof] verification failed'
    )
    process.exit(1)
  })
}
