/**
 * Daily digest (spec §15 alerting discipline): everything that didn't page
 * — long-tail breakage, Tier-B/C issues, count drifts, maintenance errors —
 * flushed once a day in a single Telegram summary.
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { alert, flushDigest } from '@/lib/ingest/alerting'
import { getIngestPool } from '@/lib/ingest/db'

/** Reject-rate watchdog: the quarantine table is only useful if someone
 *  reads it — fold per-source 24h reject counts into the digest. */
async function queueRejectSummary(): Promise<void> {
  const redis = getConnection()
  const { rows } = await getIngestPool().query<{
    slug: string
    phase: number
    rejects: number
    top_reason: string
  }>(
    `SELECT s.slug, s.phase, count(*)::int AS rejects,
            (SELECT r2.reason FROM arena.staging_rejects r2
              WHERE r2.source_id = r.source_id
                AND r2.created_at > now() - interval '24 hours'
              GROUP BY r2.reason ORDER BY count(*) DESC LIMIT 1) AS top_reason
       FROM arena.staging_rejects r
       JOIN arena.sources s ON s.id = r.source_id
      WHERE r.created_at > now() - interval '24 hours'
      GROUP BY s.slug, s.phase, r.source_id
     HAVING count(*) >= 20`
  )
  for (const r of rows) {
    await alert(redis, {
      sourceSlug: r.slug,
      phase: r.phase,
      tier: 'maint', // digest-only — quality drift, not an outage
      message: `${r.rejects} staging rejects in 24h (top: ${r.top_reason})`,
    })
  }
}

export async function processDailyDigest(_job: Job): Promise<{ flushed: number }> {
  await queueRejectSummary()
  const flushed = await flushDigest(getConnection())
  console.log(`[daily-digest] flushed ${flushed} events`)
  return { flushed }
}
