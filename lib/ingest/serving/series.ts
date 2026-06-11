/**
 * Time-series cost controls (spec §13.2): native daily granularity for the
 * trailing 90 days; older points roll up to weekly (last value per ISO
 * week) in arena.trader_series_weekly. Charts past 90d render from the
 * weekly rollup. Called by the worker maintenance job.
 *
 * WORKER-ONLY MODULE (direct PG).
 */

import { getIngestPool } from '../db'

export interface DownsampleResult {
  weeklyUpserted: number
  dailyDeleted: number
}

/** Roll up trader_series points older than `keepDays` into weekly. */
export async function downsampleOldSeries(keepDays = 90): Promise<DownsampleResult> {
  const client = await getIngestPool().connect()
  try {
    await client.query('BEGIN')

    const upsert = await client.query(
      `INSERT INTO arena.trader_series_weekly
         (trader_id, timeframe, metric, week_start, value, currency)
       SELECT DISTINCT ON (trader_id, timeframe, metric, date_trunc('week', ts))
              trader_id, timeframe, metric,
              date_trunc('week', ts)::date AS week_start,
              value, currency
         FROM arena.trader_series
        WHERE ts < now() - ($1 || ' days')::interval
        ORDER BY trader_id, timeframe, metric, date_trunc('week', ts), ts DESC
       ON CONFLICT (trader_id, timeframe, metric, week_start)
       DO UPDATE SET value = EXCLUDED.value, currency = EXCLUDED.currency`,
      [keepDays]
    )

    const del = await client.query(
      `DELETE FROM arena.trader_series
        WHERE ts < now() - ($1 || ' days')::interval`,
      [keepDays]
    )

    await client.query('COMMIT')
    return {
      weeklyUpserted: upsert.rowCount ?? 0,
      dailyDeleted: del.rowCount ?? 0,
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

/** Keep monthly partitions 2 months ahead on all partitioned arena tables. */
export async function ensurePartitions(): Promise<number> {
  const tables = [
    'leaderboard_entries',
    'trader_series',
    'position_history',
    'order_records',
    'transfer_history',
    'copier_records',
  ]
  let created = 0
  for (const table of tables) {
    const { rows } = await getIngestPool().query<{ ensure_month_partitions: number }>(
      `SELECT arena.ensure_month_partitions($1, 2)`,
      [table]
    )
    created += rows[0]?.ensure_month_partitions ?? 0
  }
  return created
}

/**
 * History retention by tier (spec §13.5): long-tail traders keep a bounded
 * window; topN/ranked traders keep full history. "Ranked" = appeared in a
 * passed snapshot within the last 30 days.
 */
export async function pruneLongTailHistories(retentionDays = 180): Promise<number> {
  const tables = ['position_history', 'order_records', 'transfer_history', 'copier_records']
  const tsCol: Record<string, string> = {
    position_history: 'closed_at',
    order_records: 'ts',
    transfer_history: 'ts',
    copier_records: 'ts',
  }
  let deleted = 0
  for (const table of tables) {
    const result = await getIngestPool().query(
      `DELETE FROM arena.${table} h
        WHERE h.${tsCol[table]} < now() - ($1 || ' days')::interval
          AND NOT EXISTS (
            SELECT 1 FROM arena.leaderboard_entries e
             WHERE e.trader_id = h.trader_id
               AND e.scraped_at > now() - interval '30 days')`,
      [retentionDays]
    )
    deleted += result.rowCount ?? 0
  }
  return deleted
}
