/**
 * Housekeeping (spec §13 storage cost controls + §2.1 RAW retention):
 *   1. monthly partitions kept 2 months ahead (all partitioned tables)
 *   2. RAW objects >30d deleted (quarantined exempt)
 *   3. trader_series >90d downsampled to weekly
 *   4. long-tail histories pruned to 180d (recently-ranked traders exempt)
 *   5. expired profile_cache rows dropped
 * Runs every 6h; each step is independent — one failure doesn't block the
 * rest, and failures land in the daily digest (never page).
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { getIngestPool } from '@/lib/ingest/db'
import { cleanupRawObjects } from '@/lib/ingest/raw'
import {
  downsampleOldSeries,
  downsampleSnapshotEntries,
  ensurePartitions,
  pruneLongTailHistories,
} from '@/lib/ingest/serving/series'
import { alert } from '@/lib/ingest/alerting'

export async function processMaintenance(_job: Job): Promise<Record<string, unknown>> {
  const redis = getConnection()
  const report: Record<string, unknown> = {}

  const steps: Array<[string, () => Promise<unknown>]> = [
    ['partitions', () => ensurePartitions()],
    ['raw_cleanup', () => cleanupRawObjects(30)],
    ['series_downsample', () => downsampleOldSeries(90)],
    ['entries_downsample', () => downsampleSnapshotEntries(7)],
    ['history_retention', () => pruneLongTailHistories(180)],
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

  for (const [name, fn] of steps) {
    try {
      report[name] = await fn()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      report[name] = `ERROR: ${message}`
      await alert(redis, {
        sourceSlug: 'framework',
        phase: 0,
        tier: 'maint',
        message: `maintenance step ${name} failed: ${message}`,
      })
    }
  }

  console.log('[maintenance]', JSON.stringify(report))
  return report
}
