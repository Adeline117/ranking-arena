/**
 * ClickHouse client module
 *
 * Provides a singleton ClickHouse client configured from environment variables.
 * Stays dormant when ClickHouse is not configured. When it is configured,
 * initialization failures are surfaced to the caller instead of silently
 * disabling the integration.
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
  query(params: {
    query: string
    query_params?: Record<string, unknown>
    format?: string
  }): Promise<{
    json<T = unknown>(): Promise<T>
    text(): Promise<string>
  }>
  insert(params: { table: string; values: unknown[]; format?: string }): Promise<void>
  close(): Promise<void>
}

interface ClickHouseClientModule {
  createClient(options: Record<string, unknown>): ClickHouseClient
}

export class ClickHouseInitializationError extends Error {
  readonly code = 'CLICKHOUSE_INITIALIZATION_FAILED'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClickHouseInitializationError'
  }
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

let clientPromise: Promise<ClickHouseClient> | null = null

async function initializeClickHouseClient(): Promise<ClickHouseClient> {
  try {
    // Keep the literal module specifier: webpack/Turbopack can analyze and trace
    // the declared runtime dependency without generating a dynamic-require warning.
    const clickHouseModule: unknown = await import('@clickhouse/client')
    if (
      typeof clickHouseModule !== 'object' ||
      clickHouseModule === null ||
      !('createClient' in clickHouseModule) ||
      typeof clickHouseModule.createClient !== 'function'
    ) {
      throw new TypeError('@clickhouse/client does not export createClient')
    }
    const { createClient } = clickHouseModule as ClickHouseClientModule
    const cfg = getConfig()
    const client = createClient({
      url: cfg.url,
      username: cfg.username,
      password: cfg.password,
      database: cfg.database,
      // Connection pool settings suitable for serverless
      request_timeout: 30_000,
      max_open_connections: 5,
      keep_alive: { enabled: true },
    })

    logger.info('[ClickHouse] Client initialized', { database: cfg.database })
    return client
  } catch (cause) {
    const error = new ClickHouseInitializationError(
      'ClickHouse is configured but the client could not be initialized',
      { cause }
    )
    logger.error('[ClickHouse] Client initialization failed:', error.message)
    throw error
  }
}

/**
 * Returns the singleton ClickHouse client.
 * Returns null without loading the client package when env vars are missing.
 * Rejects with ClickHouseInitializationError when configured initialization fails.
 */
export async function getClickHouseClient(): Promise<ClickHouseClient | null> {
  if (!isClickHouseAvailable()) return null

  clientPromise ??= initializeClickHouseClient()
  return clientPromise
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
export async function insertBatch(table: string, rows: Record<string, unknown>[]): Promise<number> {
  if (rows.length === 0) return 0

  const client = await getClickHouseClient()
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
  const client = await getClickHouseClient()
  if (!client) return null

  const result = await client.query({
    query: sql,
    query_params: params,
    format: 'JSONEachRow',
  })

  return result.json<T[]>()
}
