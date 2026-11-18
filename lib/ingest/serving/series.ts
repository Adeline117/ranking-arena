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
 * Snapshot retention (20261113110021): delete snapshots (and their entries)
 * older than `retentionDays`, never the latest passed board, a board a sealed
 * publication was built from, or a snapshot referenced by trust evidence or a
 * Tier-A receipt. Skips (returns a marker) until the migration is installed.
 */
export async function pruneLeaderboardSnapshots(
  retentionDays = 180,
  batchLimit = 5000
): Promise<{ deleted_snapshots: number; deleted_entries: number } | 'not_installed'> {
  const pool = getIngestPool()
  const { rows: installed } = await pool.query<{ present: boolean }>(
    `SELECT pg_catalog.to_regprocedure('arena.prune_leaderboard_snapshots(integer,integer)')
       IS NOT NULL AS present`
  )
  if (installed[0]?.present !== true) return 'not_installed'
  const { rows } = await pool.query<{
    result: { deleted_snapshots: number; deleted_entries: number }
  }>(`SELECT arena.prune_leaderboard_snapshots($1::integer, $2::integer) AS result`, [
    retentionDays,
    batchLimit,
  ])
  const result = rows[0]?.result
  if (!result) throw new Error('[retention] snapshot prune returned no result')
  return { deleted_snapshots: result.deleted_snapshots, deleted_entries: result.deleted_entries }
}

/** Worker env key for trust evidence retention deletes (second key: DB switch). */
export const TRUST_EVIDENCE_RETENTION_DELETE_ENV = 'INGEST_TRUST_EVIDENCE_RETENTION_DELETE'

export const TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP = 100_000
export const TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP = 1_000
export const TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY = 'arena:ingest:trust-retention:row-cap'

/** Where the adaptive row cap survives between maintenance runs (Redis in the worker). */
export interface TrustEvidenceRowCapStore {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<unknown>
}

function memoryRowCapStore(): TrustEvidenceRowCapStore {
  const values = new Map<string, string>()
  return {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value) => values.set(key, value),
  }
}
const processRowCapStore = memoryRowCapStore()

export interface TrustEvidenceRetentionReport {
  mode: 'count' | 'delete'
  delete_blocked_by: Array<'env' | 'db_switch'>
  row_cap: number
  next_row_cap: number
  result: Record<string, unknown>
}

/** statement_timeout (57014) or lock_timeout (55P03): the batch was too big or contended. */
function isBatchTimeout(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === '57014' || code === '55P03'
}

export function nextTrustEvidenceRowCap(current: number, timedOut: boolean): number {
  if (timedOut) return Math.max(TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP, Math.floor(current / 2))
  return Math.min(TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP, current * 2)
}

async function readRowCap(store: TrustEvidenceRowCapStore): Promise<number> {
  const raw = await store.get(TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY)
  const stored = raw === null || raw.trim() === '' ? NaN : Number(raw)
  if (!Number.isSafeInteger(stored)) return TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP
  return Math.min(
    TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP,
    Math.max(TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP, stored)
  )
}

/**
 * Trust evidence retention (20261118135918). Count-only unless BOTH the
 * worker env INGEST_TRUST_EVIDENCE_RETENTION_DELETE=1 and the owner-only
 * arena.trust_evidence_retention_settings.delete_enabled are on.
 *
 * One row-budgeted batch per call, inside one transaction with statement/lock
 * timeouts. A batch that times out rolls back whole; the row cap is then
 * halved (floor 1,000) for the next run, and doubled back (ceiling 100,000)
 * after each success. The database resumes an unfinished snapshot purge from
 * its last committed batch and splits large snapshots, so a smaller cap
 * always makes progress instead of retrying the same oversized batch.
 * Skips (returns a marker) until installed.
 */
export async function retainTrustEvidence(
  options: {
    env?: Record<string, string | undefined>
    rowCapStore?: TrustEvidenceRowCapStore
  } = {}
): Promise<TrustEvidenceRetentionReport | 'not_installed'> {
  const env = options.env ?? process.env
  const store = options.rowCapStore ?? processRowCapStore
  const client = await ingestClientConnect()
  let destroyClient = false
  try {
    const { rows: installed } = await client.query<{ present: boolean }>(
      `SELECT pg_catalog.to_regprocedure(
                'arena.retain_trust_evidence(boolean,integer,integer,integer,integer)'
              ) IS NOT NULL AS present`
    )
    if (installed[0]?.present !== true) return 'not_installed'

    const { rows: settings } = await client.query<{ delete_enabled: boolean }>(
      `SELECT delete_enabled FROM arena.trust_evidence_retention_settings WHERE singleton`
    )
    const blockedBy: Array<'env' | 'db_switch'> = []
    if (env[TRUST_EVIDENCE_RETENTION_DELETE_ENV] !== '1') blockedBy.push('env')
    if (settings[0]?.delete_enabled !== true) blockedBy.push('db_switch')
    const mode: 'count' | 'delete' = blockedBy.length === 0 ? 'delete' : 'count'
    const rowCap = await readRowCap(store)

    await client.query('BEGIN')
    try {
      await client.query(`SET LOCAL statement_timeout = '120s'`)
      await client.query(`SET LOCAL lock_timeout = '5s'`)
      const { rows } = await client.query<{ result: Record<string, unknown> }>(
        `SELECT arena.retain_trust_evidence($1::boolean, $2::integer) AS result`,
        [mode === 'delete', rowCap]
      )
      await client.query('COMMIT')
      const result = rows[0]?.result
      if (!result) throw new Error('[retention] trust evidence retention returned no result')
      const nextRowCap = mode === 'delete' ? nextTrustEvidenceRowCap(rowCap, false) : rowCap
      if (nextRowCap !== rowCap) {
        await store.set(TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY, String(nextRowCap))
      }
      return {
        mode,
        delete_blocked_by: blockedBy,
        row_cap: rowCap,
        next_row_cap: nextRowCap,
        result,
      }
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        destroyClient = true
      }
      if (isBatchTimeout(error)) {
        const nextRowCap = nextTrustEvidenceRowCap(rowCap, true)
        await store.set(TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY, String(nextRowCap))
        throw new Error(
          `[retention] trust evidence batch of ${rowCap} rows timed out and rolled back; ` +
            `next run uses ${nextRowCap}: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      throw error
    }
  } finally {
    client.release(destroyClient)
  }
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
