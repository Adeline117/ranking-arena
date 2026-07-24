import { ingestClientConnect } from '@/lib/ingest/db'

export const METRIC_TRUST_WORKER_READINESS_CONTRACT =
  'arena.metric-trust-release-readiness@1' as const
export const METRIC_TRUST_RELEASE_MIGRATION_PATH =
  'supabase/migrations/20260722054000_metric_trust_source_page_lineage.sql' as const
export const METRIC_TRUST_RELEASE_MIGRATION_SHA256 =
  '93c512791e8bb7beb00742c7b65c6d79ecdf79ea49e26a3d67c3b3c438ae42cf' as const
export const ARENA_PRODUCTION_PROJECT_REF = 'iknktzifjdyujdccyhsv' as const

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

function startupGateError(reason: string): Error {
  return new Error(`[ingest-worker] metric-trust startup gate failed closed: ${reason}`)
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
  if (payload.contract !== METRIC_TRUST_WORKER_READINESS_CONTRACT) {
    throw startupGateError('RPC contract is not exact')
  }
  if (
    !Array.isArray(payload.missing) ||
    !payload.missing.every((item) => typeof item === 'string')
  ) {
    throw startupGateError('RPC missing-object list is malformed')
  }
  if (
    !Number.isInteger(payload.legacy_complete_verified_count) ||
    Number(payload.legacy_complete_verified_count) < 0
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
    await client.query("SET LOCAL statement_timeout = '10s'")
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
  timeoutMs = 15_000,
}: {
  load?: LoadReadiness
  timeoutMs?: number
} = {}): Promise<void> {
  let payload: unknown
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    payload = await Promise.race([
      load(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(startupGateError('readiness RPC timed out')), timeoutMs)
      }),
    ])
  } catch {
    throw startupGateError('readiness RPC is unavailable')
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  validateMetricTrustWorkerReadiness(payload)
}
