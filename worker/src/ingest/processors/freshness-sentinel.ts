/**
 * Freshness SLA sentinel (spec §5.4): every Tier-A surface has a max age;
 * alert when the latest PASSED snapshot exceeds 2× the source's cadence.
 * Runs every 30 min. Routing follows §15 discipline: phase<=1 pages,
 * everything else goes to the daily digest.
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { getIngestPool } from '@/lib/ingest/db'
import { alert } from '@/lib/ingest/alerting'

interface StaleSurface {
  slug: string
  phase: number
  timeframe: number
  age_hours: number | null
  max_age_hours: number
}

export async function processFreshness(_job: Job): Promise<{ stale: number }> {
  const redis = getConnection()
  const { rows } = await getIngestPool().query<StaleSurface>(
    `WITH expected AS (
       SELECT s.id, s.slug, s.phase,
              unnest(s.timeframes_native) AS timeframe,
              EXTRACT(EPOCH FROM s.cadence_tier_a) / 1800 AS max_age_hours -- 2× cadence, in hours
         FROM arena.sources s
        WHERE s.status = 'active'
     ),
     latest AS (
       SELECT source_id, timeframe, max(scraped_at) AS last_good
         FROM arena.leaderboard_snapshots
        WHERE count_check_passed
        GROUP BY source_id, timeframe
     )
     SELECT e.slug, e.phase, e.timeframe,
            EXTRACT(EPOCH FROM (now() - l.last_good)) / 3600 AS age_hours,
            e.max_age_hours
       FROM expected e
       LEFT JOIN latest l ON l.source_id = e.id AND l.timeframe = e.timeframe
      WHERE e.timeframe IN (7, 30, 90)
        AND (l.last_good IS NULL OR
             l.last_good < now() - (e.max_age_hours || ' hours')::interval)`
  )

  // ONE alert per source per run, not one per (source × timeframe) — a fully
  // stalled source used to emit 3 surfaces × 48 runs/day. Combined with the
  // page cooldown in alerting.ts this caps real-time noise at ~4 pages per
  // stalled source per day.
  const bySlug = new Map<string, typeof rows>()
  for (const raw of rows) {
    const list = bySlug.get(raw.slug) ?? []
    list.push(raw)
    bySlug.set(raw.slug, list)
  }

  for (const [slug, surfaces] of bySlug) {
    // pg returns numeric columns as strings — coerce before formatting.
    const parts = surfaces.map((raw) => {
      const age = raw.age_hours === null ? null : Number(raw.age_hours)
      const sla = Number(raw.max_age_hours)
      return age === null
        ? `${raw.timeframe}d never crawled (SLA ${sla.toFixed(1)}h)`
        : `${raw.timeframe}d ${age.toFixed(1)}h old (SLA ${sla.toFixed(1)}h)`
    })
    // "Never crawled" is a rollout state, not an incident — digest only
    // (tier 'maint' never pages); a stale previously-good board pages
    // per §15 when the source is phase<=1.
    const anyStale = surfaces.some((raw) => raw.age_hours !== null)
    await alert(redis, {
      sourceSlug: slug,
      phase: surfaces[0].phase,
      tier: anyStale ? 'A' : 'maint',
      message: `stale boards: ${parts.join('; ')}`,
    })
  }

  if (rows.length > 0) {
    console.warn(`[freshness] ${rows.length} stale Tier-A surfaces`)
  }
  return { stale: rows.length }
}
