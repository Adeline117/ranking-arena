/**
 * ClickHouse client module
 *
 * Provides a singleton ClickHouse client configured from environment variables.
 * Gracefully degrades when @clickhouse/client is not installed or env vars are missing.
 *
 * Required env vars:
 *   CLICKHOUSE_URL      - e.g. http://localhost:8123
 *   CLICKHOUSE_USER     - e.g. default
 *   CLICKHOUSE_PASSWORD - e.g. ""
 *   CLICKHOUSE_DATABASE - e.g. arena
 */

import { logger } from '@/lib/logger'

// ---------------------------------------------------------------------------
// Types (mirrors @clickhouse/client essentials so we compile without the pkg)
// ---------------------------------------------------------------------------

interface ClickHouseClient {
  query(params: { query: string; query_params?: Record<string, unknown>; format?: string }): Promise<{
    json<T = unknown>(): Promise<T>
    text(): Promise<string>
  }>
  insert(params: {
    table: string
    values: unknown[]
    format?: string
  }): Promise<void>
  close(): Promise<void>
}

// ---------------------------------------------------------------------------
// Environment helpers
// ---------------------------------------------------------------------------

function getConfig() {
  return {
    url: process.env.CLICKHOUSE_URL || '',
    username: process.env.CLICKHOUSE_USER || 'default',
    password: process.env.CLICKHOUSE_PASSWORD || '',
    database: process.env.CLICKHOUSE_DATABASE || 'arena',
  }
}

/**
 * Returns true if all required ClickHouse env vars are configured.
 */
export function isClickHouseAvailable(): boolean {
  const cfg = getConfig()
  return Boolean(cfg.url && cfg.database)
}

// ---------------------------------------------------------------------------
// Singleton client
// ---------------------------------------------------------------------------

let _client: ClickHouseClient | null = null
let _initFailed = false

/**
 * Returns the singleton ClickHouse client.
 * Returns null if env vars are missing or @clickhouse/client is not installed.
 */
export function getClickHouseClient(): ClickHouseClient | null {
  if (_client) return _client
  if (_initFailed) return null
  if (!isClickHouseAvailable()) return null

  try {
    // Fully dynamic require — the variable indirection prevents Turbopack/webpack
    // from statically resolving (and failing) when @clickhouse/client is not installed.
    const pkgName = '@clickhouse/client'
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createClient } = require(pkgName) as {
      createClient: (opts: Record<string, unknown>) => ClickHouseClient
    }

    const cfg = getConfig()
    _client = createClient({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      database: cfg.database,
      // Connection pool settings suitable for serverless
      request_timeout: 30_000,
      max_open_connections: 5,
      keep_alive: { enabled: true },
    })

    logger.info('[ClickHouse] Client initialized', { url: cfg.url, database: cfg.database })
    return _client
  } catch (err) {
    _initFailed = true
    logger.warn(
      '[ClickHouse] Client init failed (package may not be installed):',
      err instanceof Error ? err.message : String(err)
    )
    return null
  }
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/**
 * Insert a batch of rows into a ClickHouse table.
 * No-op if ClickHouse is unavailable.
 *
 * @returns Number of rows inserted, or 0 if unavailable/failed.
 */
export async function insertBatch(
  table: string,
  rows: Record<string, unknown>[]
): Promise<number> {
  if (rows.length === 0) return 0

  const client = getClickHouseClient()
  if (!client) return 0

  await client.insert({
    table,
    values: rows,
    format: 'JSONEachRow',
  })

  return rows.length
}

/**
 * Execute a ClickHouse SQL query and return typed results.
 * Returns null if ClickHouse is unavailable.
 */
export async function query<T = unknown>(
  sql: string,
  params?: Record<string, unknown>
): Promise<T[] | null> {
  const client = getClickHouseClient()
  if (!client) return null

  const result = await client.query({
    query: sql,
    query_params: params,
    format: 'JSONEachRow',
  })

  return result.json<T[]>()
}
