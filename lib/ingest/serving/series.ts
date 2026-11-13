/**
 * Time-series cost controls (spec §13.2): native daily granularity for the
 * trailing 90 days; older points roll up to weekly (last value per ISO
 * week) in arena.trader_series_weekly. Charts past 90d render from the
 * weekly rollup. Called by the worker maintenance job.
 *
 * WORKER-ONLY MODULE (direct PG).
 */

import { getIngestPool, ingestClientConnect } from '../db'
import { METRIC_TRUST_EVIDENCE_PRESENT_SQL } from '../raw'

export interface DownsampleResult {
  weeklyUpserted: number
  dailyDeleted: number
}

/** Roll up trader_series points older than `keepDays` into weekly. */
export async function downsampleOldSeries(keepDays = 90): Promise<DownsampleResult> {
  const client = await ingestClientConnect()
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

/** Months of future partitions kept on every partitioned arena table. */
export const PARTITION_MONTHS_AHEAD = 3

/**
 * Keep monthly partitions PARTITION_MONTHS_AHEAD months ahead on all
 * partitioned arena tables. Each table is attempted independently so one
 * failure (lock timeout, name collision) cannot block the others; failures
 * are aggregated and re-thrown so the maintenance step still reports them.
 */
export async function ensurePartitions(): Promise<number> {
  // position_history is intentionally absent. The fail-closed bridge retires
  // automatic mutation before the 040410 writer cutover; recreating a child
  // would reopen an unreviewed maintenance write path after that boundary.
  const tables = [
    'leaderboard_entries',
    'trader_series',
    'order_records',
    'transfer_history',
    'copier_records',
  ]
  let created = 0
  const failures: string[] = []
  for (const table of tables) {
    try {
      const { rows } = await getIngestPool().query<{ ensure_month_partitions: number }>(
        `SELECT arena.ensure_month_partitions($1, $2)`,
        [table, PARTITION_MONTHS_AHEAD]
      )
      created += rows[0]?.ensure_month_partitions ?? 0
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[ensurePartitions] ${table} failed: ${message}`)
      failures.push(`${table}: ${message}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `ensurePartitions: ${failures.length}/${tables.length} tables failed (created ${created}): ${failures.join('; ')}`
    )
  }
  return created
}

/**
 * Snapshot-history downsampling: only the LATEST passed snapshot per
 * (source, TF) serves reads; older entries exist for rank-trend/churn,
 * which daily granularity fully covers. Keep all snapshots from the last
 * `keepAllDays`; beyond that keep one snapshot's entries per day (the
 * day's last passed crawl) and delete the rest — ~80% of entries volume
 * at 4-5 crawls/day.
 */
export function snapshotEntryDownsampleSql(trustEvidencePresent: boolean): string {
  // Entries carrying metric-trust observations are evidence: deleting them
  // used to CASCADE the observations away (now RESTRICT, 20261113*).
  const pinned = trustEvidencePresent
    ? `
        AND NOT EXISTS (
          SELECT 1 FROM arena.metric_trust_observations AS observation
           WHERE observation.snapshot_id = e.snapshot_id
             AND observation.trader_id = e.trader_id
             AND observation.snapshot_scraped_at = e.scraped_at
        )`
    : ''
  return `WITH keep AS (
       SELECT DISTINCT ON (source_id, timeframe, scraped_at::date) id
         FROM arena.leaderboard_snapshots
        WHERE count_check_passed
        ORDER BY source_id, timeframe, scraped_at::date, scraped_at DESC
     )
     DELETE FROM arena.leaderboard_entries e
      WHERE e.scraped_at < now() - ($1 || ' days')::interval
        AND e.snapshot_id NOT IN (SELECT id FROM keep)${pinned}`
}

export async function downsampleSnapshotEntries(keepAllDays = 7): Promise<number> {
  const pool = getIngestPool()
  const { rows } = await pool.query<{ present: boolean }>(METRIC_TRUST_EVIDENCE_PRESENT_SQL)
  const result = await pool.query(snapshotEntryDownsampleSql(rows[0]?.present === true), [
    keepAllDays,
  ])
  return result.rowCount ?? 0
}

/**
 * History retention by tier (spec §13.5): long-tail traders keep a bounded
 * window; topN/ranked traders keep full history. "Ranked" = appeared in a
 * passed snapshot within the last 30 days.
 */
export async function pruneLongTailHistories(retentionDays = 180): Promise<number> {
  // Do not mutate arena.position_history after the fail-closed bridge. Its
  // retained rows are evidence, and retirement/retention now requires a
  // separately reviewed parser-conservation contract.
  const tables = ['order_records', 'transfer_history', 'copier_records']
  const tsCol: Record<string, string> = {
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
