/**
 * Integration-test DB harness for the ingest serving layer.
 *
 * Connects to the database behind INGEST_DATABASE_URL (worker/.env) but
 * NEVER writes production tables: setup clones the needed arena DDL into a
 * dedicated `arena_test` schema
 * (CREATE TABLE ... LIKE ... INCLUDING ALL — indexes, identity sequences
 * and CHECK constraints come along, FKs deliberately don't), and the
 * production module `lib/ingest/db` is replaced via jest.mock with a pool
 * wrapper that rewrites every `arena.` schema qualifier to `arena_test.`
 * before execution. All SQL in publish.ts / count-check.ts is fully
 * schema-qualified (audited), so no statement can escape the test schema.
 * The sentinel source row uses id 9000 as a second belt-and-braces marker.
 *
 * Lifecycle: createTestSchema() in beforeAll, resetTables() in beforeEach,
 * dropTestSchema() in afterAll. Run via `npm run test:ingest-integration`
 * (separate jest config, NOT part of the default `npm run test`).
 */

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { Pool, types, type PoolClient } from 'pg'
import type { ParsedLeaderboardRow, SourceRow } from '../../core/types'

export const TEST_SCHEMA = 'arena_test'
export const SENTINEL_SOURCE_ID = 9000

// Mirror lib/ingest/db.ts: NUMERIC/BIGINT as JS numbers, so assertions see
// exactly what production code sees.
types.setTypeParser(types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)))
types.setTypeParser(types.builtins.INT8, (v) => (v === null ? null : Number(v)))

function loadIngestDatabaseUrl(): string {
  if (process.env.INGEST_DATABASE_URL) return process.env.INGEST_DATABASE_URL
  const envPath = resolve(__dirname, '../../../../worker/.env')
  const content = readFileSync(envPath, 'utf8')
  const match = content.match(/^INGEST_DATABASE_URL=["']?([^"'\r\n]+)["']?\s*$/m)
  if (!match) {
    throw new Error(`INGEST_DATABASE_URL not set and not found in ${envPath}`)
  }
  return match[1]
}

let rawPool: Pool | null = null

/** Unrewritten pool — used by the harness itself (DDL, seeds, assertions). */
export function getRawPool(): Pool {
  if (rawPool) return rawPool
  const url = loadIngestDatabaseUrl()
  rawPool = new Pool({
    connectionString: url,
    max: 4,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
    ssl:
      url.includes('127.0.0.1') || url.includes('localhost')
        ? undefined
        : { rejectUnauthorized: false },
  })
  return rawPool
}

/** Redirect every schema-qualified table reference into the test schema. */
export function rewriteSchema(sql: string): string {
  return sql.replace(/\b(arena|public)\./g, `${TEST_SCHEMA}.`)
}

function wrapClient(client: PoolClient): PoolClient {
  const wrapped = {
    query: (text: string, params?: unknown[]) => client.query(rewriteSchema(text), params),
    release: () => client.release(),
  }
  return wrapped as unknown as PoolClient
}

/** Pool facade handed to production code: rewrites schemas on every query. */
export function getWrappedPool(): Pool {
  const real = getRawPool()
  const wrapped = {
    query: (text: string, params?: unknown[]) => real.query(rewriteSchema(text), params),
    connect: async () => wrapClient(await real.connect()),
    end: async () => undefined,
  }
  return wrapped as unknown as Pool
}

/** Factory for `jest.mock('@/lib/ingest/db', () => require('./test-db').mockDbModule())`. */
export function mockDbModule(): {
  getIngestPool: () => Pool
  ingestClientConnect: () => Promise<PoolClient>
  closeIngestPool: () => Promise<void>
} {
  return {
    getIngestPool: () => getWrappedPool(),
    ingestClientConnect: async () => wrapClient(await getRawPool().connect()),
    closeIngestPool: async () => undefined,
  }
}

/** [clone name in arena_test, fully-qualified source table] */
const CLONE_TABLES: Array<[string, string]> = [
  ['sources', 'arena.sources'],
  ['traders', 'arena.traders'],
  ['leaderboard_snapshots', 'arena.leaderboard_snapshots'],
  ['leaderboard_entries', 'arena.leaderboard_entries'],
  ['trader_stats', 'arena.trader_stats'],
  ['trader_series', 'arena.trader_series'],
  ['trader_series_weekly', 'arena.trader_series_weekly'],
  ['staging_rejects', 'arena.staging_rejects'],
]

export async function createTestSchema(): Promise<void> {
  const pool = getRawPool()
  await pool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`)
  await pool.query(`CREATE SCHEMA ${TEST_SCHEMA}`)
  for (const [name, source] of CLONE_TABLES) {
    await pool.query(`CREATE TABLE ${TEST_SCHEMA}.${name} (LIKE ${source} INCLUDING ALL)`)
  }
}

export async function dropTestSchema(): Promise<void> {
  if (!rawPool) return
  await rawPool.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`)
  await rawPool.end()
  rawPool = null
}

export async function resetTables(): Promise<void> {
  const list = CLONE_TABLES.map(([name]) => `${TEST_SCHEMA}.${name}`).join(', ')
  await getRawPool().query(`TRUNCATE ${list} RESTART IDENTITY`)
}

export function makeSource(overrides: Partial<SourceRow> = {}): SourceRow {
  return {
    id: SENTINEL_SOURCE_ID,
    slug: 'arena_test_src',
    exchange_id: 1,
    product_type: 'futures',
    trader_kind_scope: 'human',
    adapter_slug: 'arena-test',
    leaderboard_url: null,
    timeframes_native: [7, 30, 90],
    timeframes_derived: [],
    tf_label_map: {},
    expected_count: 100,
    deep_profile_topn: 300,
    positions_topn: 100,
    profile_cache_ttl: '6 hours',
    copier_table_depth: 'full',
    currency: 'USDT',
    page_size: null,
    pagination_kind: null,
    cadence_tier_a: '5 hours',
    cadence_tier_b: '18 hours',
    cadence_tier_d: '2 hours',
    fetch_region: 'local',
    rate_budget_ms: 2500,
    phase: 0,
    serving_mode: 'shadow',
    status: 'active',
    meta: {},
    ...overrides,
  }
}

/** Insert the matching arena_test.sources row. */
export async function insertSourceRow(src: SourceRow): Promise<void> {
  await getRawPool().query(
    `INSERT INTO ${TEST_SCHEMA}.sources
       (id, slug, exchange_id, product_type, adapter_slug, expected_count,
        currency, serving_mode, status, meta)
     OVERRIDING SYSTEM VALUE
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      src.id,
      src.slug,
      src.exchange_id,
      src.product_type,
      src.adapter_slug,
      src.expected_count,
      src.currency,
      src.serving_mode,
      src.status,
      JSON.stringify(src.meta),
    ]
  )
}

/** Seed a historical snapshot row directly (baseline-pool construction). */
export async function seedSnapshot(opts: {
  actualCount: number
  passed: boolean
  minutesAgo: number
  sourceId?: number
  timeframe?: number
}): Promise<void> {
  await getRawPool().query(
    `INSERT INTO ${TEST_SCHEMA}.leaderboard_snapshots
       (source_id, timeframe, scraped_at, actual_count, count_check_passed)
     VALUES ($1, $2, now() - make_interval(mins => $3), $4, $5)`,
    [
      opts.sourceId ?? SENTINEL_SOURCE_ID,
      opts.timeframe ?? 7,
      opts.minutesAgo,
      opts.actualCount,
      opts.passed,
    ]
  )
}

export function makeRows(
  n: number,
  overrides: Partial<ParsedLeaderboardRow> = {}
): ParsedLeaderboardRow[] {
  return Array.from({ length: n }, (_, i) => ({
    exchangeTraderId: `t-${i + 1}`,
    rank: i + 1,
    nickname: `Trader ${i + 1}`,
    avatarUrlOrigin: null,
    walletAddress: null,
    traderKind: 'human' as const,
    botStrategy: null,
    headlineRoi: 12.5,
    headlinePnl: 1000 + i,
    headlineWinRate: 55,
    raw: { seed: i },
    ...overrides,
  }))
}

export async function countRows(table: string): Promise<number> {
  const { rows } = await getRawPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.${table}`
  )
  return rows[0].n
}
