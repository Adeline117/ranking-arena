/**
 * Dual-write adapter: Supabase (primary) + ClickHouse (secondary)
 *
 * ClickHouse writes are fire-and-forget — failures are logged but never
 * block or fail Supabase operations.
 */

import { logger } from '@/lib/logger'
import { isClickHouseAvailable, insertBatch } from './clickhouse'

const chLogger = logger.child('ClickHouse')

/**
 * Sync a batch of rows to ClickHouse.
 *
 * - No-op if ClickHouse is not configured (env vars missing).
 * - Wraps in try/catch so failures never propagate to callers.
 * - Logs success count and any errors.
 *
 * @param table  - ClickHouse table name
 * @param rows   - Array of row objects matching the table schema
 */
export async function syncToClickHouse(
  table: string,
  rows: Record<string, unknown>[]
): Promise<void> {
  if (!isClickHouseAvailable()) return
  if (rows.length === 0) return

  try {
    const inserted = await insertBatch(table, rows)
    chLogger.info(`Synced ${inserted} rows to ${table}`)
  } catch (err) {
    // ClickHouse failures must NOT block the Supabase write path
    chLogger.warn(
      `Failed to sync ${rows.length} rows to ${table}:`,
      err instanceof Error ? err.message : String(err)
    )
  }
}

/**
 * Sync a pipeline log entry to ClickHouse.
 * Converts from Supabase pipeline_logs format.
 */
export async function syncPipelineLog(entry: {
  id: number | string
  job_name: string
  status: string
  started_at?: string
  ended_at?: string | null
  duration_ms?: number | null
  records_processed?: number | null
  error_message?: string | null
  metadata?: Record<string, unknown> | null
}): Promise<void> {
  await syncToClickHouse('pipeline_logs', [
    {
      id: typeof entry.id === 'number' ? crypto.randomUUID() : entry.id,
      job_name: entry.job_name,
      status: entry.status,
      started_at: entry.started_at ?? new Date().toISOString(),
      finished_at: entry.ended_at ?? null,
      duration_ms: entry.duration_ms ?? null,
      records_processed: entry.records_processed ?? null,
      error_message: entry.error_message ?? null,
      metadata: JSON.stringify(entry.metadata ?? {}),
    },
  ])
}
