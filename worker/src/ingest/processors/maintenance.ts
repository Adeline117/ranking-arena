/**
 * Housekeeping (spec §13 storage cost controls + §2.1 RAW retention):
 *   1. monthly partitions kept 3 months ahead (all partitioned tables)
 *   2. RAW objects >30d deleted (quarantined exempt)
 *   3. trader_series >90d downsampled to weekly
 *   4. long-tail histories pruned to 180d (recently-ranked traders exempt)
 *   5. expired profile_cache rows dropped
 *   6. leaderboard snapshots >180d dropped unless still evidence
 *      (latest passed / sealed-publication board / trust / Tier-A receipt)
 *   7. open positions of traders that left the Tier-D cohort dropped
 *   8. trust evidence retention (20261118135918): superseded/failed snapshot
 *      evidence counted per table; deleted only with BOTH
 *      INGEST_TRUST_EVIDENCE_RETENTION_DELETE=1 and the owner DB switch
 *   9. RAW retention backlog (20261118134316): census + orphan walk, count
 *      only unless INGEST_RAW_RETENTION_DELETE=1 AND the DB switch is on
 * Runs every 6h; each step is independent — one failure doesn't block the
 * rest, and failures land in the daily digest. A partitions failure also
 * pages: without the month's child partition every write to that table fails
 * (there is deliberately no DEFAULT partition — a row parked there would make
 * creating its month's child fail forever).
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { getIngestPool } from '@/lib/ingest/db'
import { cleanupRawObjects } from '@/lib/ingest/raw'
import { runRawRetention } from '@/lib/ingest/raw-retention'
import {
  downsampleOldSeries,
  downsampleSnapshotEntries,
  ensurePartitions,
  pruneLeaderboardSnapshots,
  pruneLongTailHistories,
  retainTrustEvidence,
} from '@/lib/ingest/serving/series'
import { alert } from '@/lib/ingest/alerting'
import { NATIVE_COHORT_MAX_SNAPSHOT_AGE_SECONDS } from '@/lib/ingest/native-cohort'

/** Off-cohort open positions are kept this long (on-demand Tier-C refreshes). */
export const OFF_COHORT_POSITIONS_GRACE_SECONDS = 24 * 3600
/** Rows deleted per maintenance run (runs every 6h). */
export const OFF_COHORT_POSITIONS_BATCH = 5000

/**
 * Tier-D only refreshes the top `positions_topn` of each source's latest fresh
 * PASSED native boards (same cohort as tier-d-positions getPositionTargets).
 * A trader that left that cohort keeps its last open-position set forever
 * otherwise. Only sources WITH a fresh cohort are touched, so a stalled
 * Tier A never empties a source's positions.
 * $1 cohort max snapshot age (s), $2 grace (s), $3 batch.
 */
export const PRUNE_OFF_COHORT_POSITIONS_SQL = `
WITH latest AS (
  SELECT DISTINCT ON (s.source_id, s.timeframe) s.id AS snapshot_id, s.source_id
    FROM arena.leaderboard_snapshots s
   WHERE s.count_check_passed
     AND NOT s.is_derived
     AND s.scraped_at > now() - make_interval(secs => $1::int)
   ORDER BY s.source_id, s.timeframe, s.scraped_at DESC, s.id DESC
),
cohort AS (
  SELECT DISTINCT e.trader_id
    FROM latest l
    JOIN arena.sources src ON src.id = l.source_id
    JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
    JOIN arena.traders t ON t.id = e.trader_id
   WHERE e.rank <= src.positions_topn
     AND (t.meta->>'claimed') IS DISTINCT FROM 'true'
),
doomed AS (
  SELECT pc.trader_id, pc.symbol, pc.side
    FROM arena.positions_current pc
    JOIN arena.traders t ON t.id = pc.trader_id
   WHERE pc.snapshot_at < now() - make_interval(secs => $2::int)
     AND t.source_id IN (SELECT source_id FROM latest)
     AND NOT EXISTS (SELECT 1 FROM cohort c WHERE c.trader_id = pc.trader_id)
   LIMIT $3::int
)
DELETE FROM arena.positions_current pc
 USING doomed d
 WHERE pc.trader_id = d.trader_id AND pc.symbol = d.symbol AND pc.side = d.side`

export async function processMaintenance(_job: Job): Promise<Record<string, unknown>> {
  const redis = getConnection()
  const report: Record<string, unknown> = {}

  const steps: Array<[string, () => Promise<unknown>]> = [
    ['partitions', () => ensurePartitions()],
    ['raw_cleanup', () => cleanupRawObjects(30)],
    ['raw_retention', () => runRawRetention()],
    ['series_downsample', () => downsampleOldSeries(90)],
    ['entries_downsample', () => downsampleSnapshotEntries(7)],
    ['snapshot_retention', () => pruneLeaderboardSnapshots(180)],
    // Adaptive row cap survives restarts in Redis (halved after a timeout).
    ['trust_evidence_retention', () => retainTrustEvidence({ rowCapStore: redis })],
    ['history_retention', () => pruneLongTailHistories(180)],
    [
      'positions_off_cohort',
      async () => {
        const r = await getIngestPool().query(PRUNE_OFF_COHORT_POSITIONS_SQL, [
          NATIVE_COHORT_MAX_SNAPSHOT_AGE_SECONDS,
          OFF_COHORT_POSITIONS_GRACE_SECONDS,
          OFF_COHORT_POSITIONS_BATCH,
        ])
        return r.rowCount ?? 0
      },
    ],
    [
      'profile_cache_expiry',
      async () => {
        const r = await getIngestPool().query(
          `DELETE FROM arena.profile_cache WHERE expires_at < now() - interval '7 days'`
        )
        return r.rowCount ?? 0
      },
    ],
  ]

  let undeliveredPage: unknown
  for (const [name, fn] of steps) {
    try {
      report[name] = await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report[name] = `ERROR: ${message}`
      try {
        await alert(redis, {
          sourceSlug: 'framework',
          phase: 0,
          tier: 'maint',
          message: `maintenance step ${name} failed: ${message}`,
          page: name === 'partitions',
        })
      } catch (alertError) {
        // Run the remaining steps, then fail the job so the miss is visible.
        undeliveredPage = alertError
      }
    }
  }

  console.log('[maintenance]', JSON.stringify(report))
  if (undeliveredPage !== undefined) throw undeliveredPage
  return report
}
