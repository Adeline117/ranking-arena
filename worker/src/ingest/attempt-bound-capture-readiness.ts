import { ingestClientConnect } from '@/lib/ingest/db'

export const PARTITIONED_V4_WORKER_READINESS_CONTRACT =
  'arena.partitioned-leaderboard-worker-readiness@1' as const
export const PARTITIONED_V4_CAPTURE_CONTRACT =
  'arena.ingest.leaderboard-acquisition-manifest@4' as const
export const PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT =
  'arena.ingest.leaderboard-acquisition-attempt-binding@1' as const
export const PARTITIONED_V4_START_RPC_SHA256 =
  '3fe0c7fb170dfd43022f07736012f84cd5083a8e79e038e037efae2b6462cdcd' as const
export const PARTITIONED_V4_FINISH_RPC_SHA256 =
  '3b40b3f8c79a7187edfe42e9f419e79a4d445625d6e6a9c13926470897eb35cb' as const

const START_RPC_SIGNATURE =
  'arena.start_leaderboard_acquisition_attempt(uuid,integer,integer,text,text,integer,text,text,text)'
const FINISH_RPC_SIGNATURE =
  'arena.finish_leaderboard_acquisition_attempt(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,text,bigint,bigint,bigint,integer,text,integer,integer,text,integer,integer,integer,integer,boolean,boolean,text,text)'

const REGISTRY_ROW_KEYS = [
  'adapter_slug',
  'attempt_binding_contract',
  'boards',
  'cadence_contract_exact',
  'capture_contract',
  'currency',
  'exchange_slug',
  'page_size',
  'pagination_kind',
  'product_type',
  'requires_runner_git_sha',
  'serving_mode',
  'source_adapter_slug',
  'source_slug',
  'status',
  'timeframes_derived',
  'timeframes_native',
  'trader_kind_scope',
] as const
const RPC_ROW_KEYS = [
  'finish_contract_exact',
  'finish_rpc_sha256',
  'rpc_acl_exact',
  'start_contract_exact',
  'start_rpc_sha256',
] as const
const EXPECTED_SOURCE_SLUGS = ['bitget_bots_futures', 'bitget_bots_spot'] as const

const REGISTRY_SQL = `WITH candidate_sources AS (
    SELECT capture.source_id
    FROM arena.leaderboard_capture_contracts AS capture
    WHERE capture.capture_contract =
          'arena.ingest.leaderboard-acquisition-manifest@4'
    UNION
    SELECT source_row.id AS source_id
    FROM arena.sources AS source_row
    WHERE source_row.status = 'active'
      AND source_row.adapter_slug = 'bitget_bots'
  )
  SELECT
    source_row.slug AS source_slug,
    exchange_row.slug AS exchange_slug,
    source_row.adapter_slug AS source_adapter_slug,
    source_row.product_type,
    source_row.trader_kind_scope,
    source_row.status,
    source_row.serving_mode,
    source_row.currency,
    source_row.timeframes_native,
    source_row.timeframes_derived,
    source_row.page_size,
    source_row.pagination_kind,
    source_row.meta->'boards' AS boards,
    (
      source_row.cadence_tier_a > interval '0 seconds'
      AND source_row.cadence_tier_a <= interval '7 days'
    ) AS cadence_contract_exact,
    capture.capture_contract,
    capture.adapter_slug,
    capture.attempt_binding_contract,
    capture.requires_runner_git_sha
  FROM candidate_sources AS candidate
  JOIN arena.sources AS source_row
    ON source_row.id = candidate.source_id
  JOIN arena.exchanges AS exchange_row
    ON exchange_row.id = source_row.exchange_id
  LEFT JOIN arena.leaderboard_capture_contracts AS capture
    ON capture.source_id = source_row.id
   AND capture.capture_contract =
       'arena.ingest.leaderboard-acquisition-manifest@4'
  ORDER BY source_row.slug ASC`

const RPC_SQL = `SELECT
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(start_proc.prosrc, 'UTF8')),
      'hex'
    ) AS start_rpc_sha256,
    pg_catalog.encode(
      pg_catalog.sha256(pg_catalog.convert_to(finish_proc.prosrc, 'UTF8')),
      'hex'
    ) AS finish_rpc_sha256,
    (
      start_proc.prokind = 'f'
      AND start_proc.proowner = 'postgres'::pg_catalog.regrole
      AND start_proc.prosecdef
      AND start_proc.provolatile = 'v'
      AND start_language.lanname = 'plpgsql'
      AND start_proc.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'statement_timeout=30s'
      ]::pg_catalog.text[]
    ) AS start_contract_exact,
    (
      finish_proc.prokind = 'f'
      AND finish_proc.proowner = 'postgres'::pg_catalog.regrole
      AND finish_proc.prosecdef
      AND finish_proc.provolatile = 'v'
      AND finish_language.lanname = 'plpgsql'
      AND finish_proc.proconfig @> ARRAY[
        'search_path=pg_catalog, pg_temp',
        'lock_timeout=5s',
        'statement_timeout=30s'
      ]::pg_catalog.text[]
    ) AS finish_contract_exact,
    (
      pg_catalog.has_function_privilege(
        'service_role',
        '${START_RPC_SIGNATURE}',
        'EXECUTE'
      )
      AND pg_catalog.has_function_privilege(
        'service_role',
        '${FINISH_RPC_SIGNATURE}',
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        'anon',
        '${START_RPC_SIGNATURE}',
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        'anon',
        '${FINISH_RPC_SIGNATURE}',
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        'authenticated',
        '${START_RPC_SIGNATURE}',
        'EXECUTE'
      )
      AND NOT pg_catalog.has_function_privilege(
        'authenticated',
        '${FINISH_RPC_SIGNATURE}',
        'EXECUTE'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            start_proc.proacl,
            pg_catalog.acldefault('f', start_proc.proowner)
          )
        ) AS acl_row
        WHERE acl_row.privilege_type = 'EXECUTE'
          AND acl_row.grantee NOT IN (
            start_proc.proowner,
            'service_role'::pg_catalog.regrole
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM pg_catalog.aclexplode(
          COALESCE(
            finish_proc.proacl,
            pg_catalog.acldefault('f', finish_proc.proowner)
          )
        ) AS acl_row
        WHERE acl_row.privilege_type = 'EXECUTE'
          AND acl_row.grantee NOT IN (
            finish_proc.proowner,
            'service_role'::pg_catalog.regrole
          )
      )
    ) AS rpc_acl_exact
  FROM pg_catalog.pg_proc AS start_proc
  JOIN pg_catalog.pg_language AS start_language
    ON start_language.oid = start_proc.prolang
  CROSS JOIN pg_catalog.pg_proc AS finish_proc
  JOIN pg_catalog.pg_language AS finish_language
    ON finish_language.oid = finish_proc.prolang
  WHERE start_proc.oid = '${START_RPC_SIGNATURE}'::pg_catalog.regprocedure
    AND finish_proc.oid = '${FINISH_RPC_SIGNATURE}'::pg_catalog.regprocedure`

type ReadinessQueryResult = {
  rowCount: number | null
  rows: Array<Record<string, unknown>>
}

export type AttemptBoundCaptureReadinessClient = {
  query: (sql: string) => Promise<ReadinessQueryResult>
  release: () => void
}

type ConnectReadinessClient = () => Promise<AttemptBoundCaptureReadinessClient>
type LoadReadiness = () => Promise<unknown>

export type PartitionedV4WorkerReadiness = {
  contract: typeof PARTITIONED_V4_WORKER_READINESS_CONTRACT
  registry: Array<Record<string, unknown>>
  rpc: Record<string, unknown>
}

function startupGateError(reason: string): Error {
  return new Error(`[ingest-worker] partitioned V4 startup gate failed closed: ${reason}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

export function validatePartitionedV4WorkerReadiness(payload: unknown): void {
  if (!isRecord(payload) || !hasExactKeys(payload, ['contract', 'registry', 'rpc'])) {
    throw startupGateError('readiness payload is malformed')
  }
  if (payload.contract !== PARTITIONED_V4_WORKER_READINESS_CONTRACT) {
    throw startupGateError('readiness contract is not exact')
  }
  if (!Array.isArray(payload.registry) || payload.registry.length !== 2) {
    throw startupGateError('capture registry cardinality is not exact')
  }
  for (const [index, sourceSlug] of EXPECTED_SOURCE_SLUGS.entries()) {
    const row = payload.registry[index]
    const futures = sourceSlug === 'bitget_bots_futures'
    if (
      !isRecord(row) ||
      !hasExactKeys(row, REGISTRY_ROW_KEYS) ||
      row.source_slug !== sourceSlug ||
      row.exchange_slug !== 'bitget' ||
      row.source_adapter_slug !== 'bitget_bots' ||
      row.product_type !== (futures ? 'futures' : 'spot') ||
      row.trader_kind_scope !== 'bot' ||
      row.status !== 'active' ||
      row.serving_mode !== 'serving' ||
      row.currency !== 'USDT' ||
      JSON.stringify(row.timeframes_native) !== JSON.stringify([30]) ||
      JSON.stringify(row.timeframes_derived) !== JSON.stringify([]) ||
      row.page_size !== 20 ||
      row.pagination_kind !== 'numeric' ||
      JSON.stringify(row.boards) !==
        JSON.stringify(
          futures ? ['futures_grid', 'futures_martingale'] : ['spot_grid', 'spot_martingale']
        ) ||
      row.cadence_contract_exact !== true ||
      row.capture_contract !== PARTITIONED_V4_CAPTURE_CONTRACT ||
      row.adapter_slug !== 'bitget_bots' ||
      row.attempt_binding_contract !== PARTITIONED_V4_ATTEMPT_BINDING_CONTRACT ||
      row.requires_runner_git_sha !== true
    ) {
      throw startupGateError('capture registry is not exact')
    }
  }
  if (!isRecord(payload.rpc) || !hasExactKeys(payload.rpc, RPC_ROW_KEYS)) {
    throw startupGateError('acquisition RPC proof is malformed')
  }
  if (
    payload.rpc.start_rpc_sha256 !== PARTITIONED_V4_START_RPC_SHA256 ||
    payload.rpc.finish_rpc_sha256 !== PARTITIONED_V4_FINISH_RPC_SHA256 ||
    payload.rpc.start_contract_exact !== true ||
    payload.rpc.finish_contract_exact !== true ||
    payload.rpc.rpc_acl_exact !== true
  ) {
    throw startupGateError('acquisition RPC contract is not exact')
  }
}

async function connectDefault(): Promise<AttemptBoundCaptureReadinessClient> {
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

export async function loadPartitionedV4WorkerReadiness({
  connect = connectDefault,
}: {
  connect?: ConnectReadinessClient
} = {}): Promise<PartitionedV4WorkerReadiness> {
  const client = await connect()
  let inTransaction = false
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    inTransaction = true
    await client.query("SET LOCAL statement_timeout = '10s'")
    const registry = await client.query(REGISTRY_SQL)
    const rpc = await client.query(RPC_SQL)
    if (registry.rowCount !== 2 || registry.rows.length !== 2) {
      throw startupGateError('capture registry row cardinality is not exact')
    }
    if (rpc.rowCount !== 1 || rpc.rows.length !== 1) {
      throw startupGateError('acquisition RPC row cardinality is not exact')
    }
    await client.query('COMMIT')
    inTransaction = false
    return {
      contract: PARTITIONED_V4_WORKER_READINESS_CONTRACT,
      registry: registry.rows,
      rpc: rpc.rows[0],
    }
  } catch (error) {
    if (inTransaction) {
      await client.query('ROLLBACK').catch(() => undefined)
    }
    throw error
  } finally {
    client.release()
  }
}

export async function assertPartitionedV4WorkerReadiness({
  load = loadPartitionedV4WorkerReadiness,
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
        timeout = setTimeout(() => reject(startupGateError('readiness query timed out')), timeoutMs)
      }),
    ])
  } catch {
    throw startupGateError('readiness query is unavailable')
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
  validatePartitionedV4WorkerReadiness(payload)
}
