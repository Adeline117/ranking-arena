import { ingestClientConnect } from '@/lib/ingest/db'
import { describeSafeCauseChain } from './safe-error-cause'

export const METRIC_TRUST_WORKER_READINESS_CONTRACT =
  'arena.metric-trust-release-readiness@2' as const
export const METRIC_TRUST_RELEASE_MIGRATION_PATH =
  'supabase/migrations/20260722055000_metric_trust_source_page_lineage_forward_repair.sql' as const
export const METRIC_TRUST_RELEASE_MIGRATION_SHA256 =
  'ed630f6f9f152a3b135569eda39f0cb4221894f7366d4a87954042f3f8b01271' as const
export const ARENA_PRODUCTION_PROJECT_REF = 'iknktzifjdyujdccyhsv' as const

const QUARANTINED_READINESS_CONTRACT = 'arena.metric-trust-release-readiness@1'
const QUARANTINED_054_MIGRATION_SHA256 =
  '93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf'

const READINESS_KEYS = [
  'contract',
  'legacy_complete_verified_count',
  'missing',
  'ready',
  'release_migration_sha256',
  'source_page_lineage_column',
] as const

type ReadinessQueryResult = {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

export type MetricTrustReadinessClient = {
  query: (sql: string) => Promise<ReadinessQueryResult>
  release: () => void
}

type ConnectReadinessClient = () => Promise<MetricTrustReadinessClient>
type LoadReadiness = () => Promise<unknown>

/** A refusal this gate raised itself; its reason is already safe to show. */
export class MetricTrustStartupGateError extends Error {
  constructor(reason: string) {
    super(`[ingest-worker] metric-trust startup gate failed closed: ${reason}`)
    this.name = 'MetricTrustStartupGateError'
  }
}

function startupGateError(reason: string): Error {
  return new MetricTrustStartupGateError(reason)
}

/**
 * Budgets of the gate. The deploy scripts wait for a release to prove liveness
 * and must wait longer than this (scripts/qa/local-scoring-deploy.test.mjs).
 */
export const METRIC_TRUST_READINESS_STATEMENT_TIMEOUT_SECONDS = 90
export const METRIC_TRUST_READINESS_GATE_TIMEOUT_MS = 100_000

export type MetricTrustReadinessFailureCategory =
  | 'connect_timeout'
  | 'network'
  | 'statement_timeout'
  | 'rpc_missing'
  | 'other'

const NETWORK_ERRNO = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ETIMEDOUT',
])

/**
 * Why the readiness call failed, from fields that cannot carry a connection
 * string or SQL. On 2026-11-26 a scoring deploy during a network outage logged
 * only "readiness RPC is unavailable", which reads like a missing migration;
 * the real cause (the 10 s connection timeout) had to be inferred from the
 * spacing of the restarts.
 */
export function classifyReadinessFailure(error: unknown): MetricTrustReadinessFailureCategory {
  for (let current: unknown = error, depth = 0; depth < 4; depth += 1) {
    if (!(current instanceof Error)) break
    const code = (current as { code?: unknown }).code
    if (code === '57014') return 'statement_timeout'
    if (code === '42883' || code === 'PGRST202') return 'rpc_missing'
    if (typeof code === 'string' && NETWORK_ERRNO.has(code)) return 'network'
    // node-postgres raises these two without a code; the texts are its own
    // fixed literals, compared whole and never logged.
    if (
      current.message === 'timeout exceeded when trying to connect' ||
      current.message === 'Connection terminated due to connection timeout'
    ) {
      return 'connect_timeout'
    }
    current = (current as { cause?: unknown }).cause
  }
  return 'other'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assertArenaProductionDatabaseUrl(rawUrl: string | undefined): void {
  if (!rawUrl) throw startupGateError('production database URL is unavailable')

  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw startupGateError('production database URL is malformed')
  }

  const hostname = url.hostname.toLowerCase()
  const username = url.username.toLowerCase()
  const directHost = hostname === `db.${ARENA_PRODUCTION_PROJECT_REF}.supabase.co`
  const projectBoundPooler =
    hostname.endsWith('.pooler.supabase.com') &&
    (username === ARENA_PRODUCTION_PROJECT_REF ||
      username.endsWith(`.${ARENA_PRODUCTION_PROJECT_REF}`))
  const queryEntries = [...url.searchParams.entries()]
  const safeQuery =
    queryEntries.length === 0 ||
    (queryEntries.length === 1 &&
      queryEntries[0][0] === 'sslmode' &&
      ['require', 'no-verify', 'verify-full'].includes(queryEntries[0][1]))
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    url.port !== '5432' ||
    url.pathname !== '/postgres' ||
    url.password.length === 0 ||
    url.hash !== '' ||
    !safeQuery ||
    (!directHost && !projectBoundPooler)
  ) {
    throw startupGateError('database URL is not the Arena production session pooler')
  }
}

export function validateMetricTrustWorkerReadiness(payload: unknown): void {
  if (!isRecord(payload)) throw startupGateError('RPC payload is not an object')
  if (JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(READINESS_KEYS)) {
    throw startupGateError('RPC payload keys are malformed')
  }
  if (
    payload.contract === QUARANTINED_READINESS_CONTRACT ||
    payload.release_migration_sha256 === QUARANTINED_054_MIGRATION_SHA256
  ) {
    throw startupGateError('quarantined 054 readiness proof is unsupported')
  }
  if (payload.contract !== METRIC_TRUST_WORKER_READINESS_CONTRACT) {
    throw startupGateError('RPC contract is not exact')
  }
  if (
    !Array.isArray(payload.missing) ||
    payload.missing.some(
      (item) => typeof item !== 'string' || item.length === 0 || item.trim() !== item
    ) ||
    new Set(payload.missing).size !== payload.missing.length
  ) {
    throw startupGateError('RPC missing-object list is malformed')
  }
  if (
    typeof payload.legacy_complete_verified_count !== 'number' ||
    !Number.isSafeInteger(payload.legacy_complete_verified_count) ||
    payload.legacy_complete_verified_count < 0
  ) {
    throw startupGateError('legacy lineage count is malformed')
  }
  if (payload.release_migration_sha256 !== METRIC_TRUST_RELEASE_MIGRATION_SHA256) {
    throw startupGateError('release migration ledger digest is not exact')
  }
  if (payload.source_page_lineage_column !== true) {
    throw startupGateError('source-page lineage column is unavailable')
  }
  if (payload.legacy_complete_verified_count !== 0) {
    throw startupGateError('legacy verified observations require quarantine')
  }
  if (payload.missing.length !== 0) {
    throw startupGateError('required database objects are missing')
  }
  if (payload.ready !== true) {
    throw startupGateError('RPC ready flag is not exact')
  }
}

async function connectDefault(): Promise<MetricTrustReadinessClient> {
  const client = await ingestClientConnect()
  return {
    query: async (sql) => {
      const result = await client.query(sql)
      return {
        rowCount: result.rowCount,
        rows: result.rows as Array<Record<string, unknown>>,
      }
    },
    release: () => client.release(),
  }
}

export async function loadMetricTrustWorkerReadiness({
  connect = connectDefault,
  databaseUrl = process.env.INGEST_DATABASE_URL ?? process.env.DATABASE_URL,
}: {
  connect?: ConnectReadinessClient
  databaseUrl?: string
} = {}): Promise<unknown> {
  assertArenaProductionDatabaseUrl(databaseUrl)
  const client = await connect()
  let inTransaction = false
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    inTransaction = true
    // The readiness RPC scans every complete/verified observation to prove
    // none predates the lineage contract. Once the public boards resumed that
    // table passed 1.5M rows and the call took ~15s in production
    // (2026-11-22), so a 10s budget failed every worker start and deploy
    // preflight closed. 25s here, 30s for the caller's race; the RPC itself
    // must be made cheap again (bounded scan) before the table doubles.
    //
    // 2026-11-25: with binance_futures and bybit_mt5 publishing, the RPC's
    // per-run lineage statement measured 19.5-20.7s warm in production (1.2M
    // buffer hits; one exhaustion proof per run in the freshness horizon), so
    // 25s left no margin: one slow call would fail every restart and leave
    // ingestion down. 90s here, 100s for the caller's race, until the per-run
    // proof stops being recomputed on every start.
    await client.query(
      `SET LOCAL statement_timeout = '${METRIC_TRUST_READINESS_STATEMENT_TIMEOUT_SECONDS}s'`
    )
    const result = await client.query(
      'SELECT public.arena_metric_trust_release_readiness() AS readiness'
    )
    if (result.rowCount !== 1 || result.rows.length !== 1 || !('readiness' in result.rows[0])) {
      throw startupGateError('RPC row cardinality is not exact')
    }
    await client.query('COMMIT')
    inTransaction = false
    return result.rows[0].readiness
  } catch (error) {
    if (inTransaction) {
      await client.query('ROLLBACK').catch(() => undefined)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function assertMetricTrustWorkerReadiness({
  load = loadMetricTrustWorkerReadiness,
  timeoutMs = METRIC_TRUST_READINESS_GATE_TIMEOUT_MS,
}: {
  load?: LoadReadiness
  timeoutMs?: number
} = {}): Promise<void> {
  let payload: unknown
  let timeout: ReturnType<typeof setTimeout> | undefined
  const raceTimeout = startupGateError('readiness RPC timed out')
  try {
    payload = await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(raceTimeout), timeoutMs)
      }),
    ])
  } catch (error) {
    // A refusal raised by this gate (bad URL, wrong row count, the race
    // timeout above) already says what happened.
    if (error instanceof MetricTrustStartupGateError) {
      logStartupGateExit(error === raceTimeout ? 'race_timeout' : 'refused')
      throw error
    }
    const category = classifyReadinessFailure(error)
    logStartupGateExit(category)
    throw startupGateError(
      `readiness RPC is unavailable (${category}; cause: ${describeSafeCauseChain(error)})`
    )
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  try {
    validateMetricTrustWorkerReadiness(payload)
  } catch (error) {
    logStartupGateExit('contract')
    throw error
  }
}

/**
 * One fixed-format line per failed start, so a restart count can be split by
 * cause with `grep -c` (329 restarts on 2026-11-26 were all one outage; the
 * category was only visible inside a stack trace). Every caller of the gate
 * exits when it fails.
 */
function logStartupGateExit(
  category: MetricTrustReadinessFailureCategory | 'race_timeout' | 'refused' | 'contract'
): void {
  console.error(`[startup-gate] exit category=${category}`)
}
