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
import { alertUncoveredRegions } from '../region-coverage'

interface StaleSurface {
  slug: string
  phase: number
  timeframe: number
  age_hours: number | null
  max_age_hours: number
}

export async function processFreshness(
  _job: Job
): Promise<{ stale: number; pendingShifts: number; uncoveredRegions: string[] }> {
  const redis = getConnection()
  // Before the DB query: region coverage must not depend on it.
  const uncoveredRegions = await alertUncoveredRegions(redis)
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
  const pendingShifts = await alertPendingCountShifts(redis)
  return { stale: rows.length, pendingShifts, uncoveredRegions }
}

interface PendingCountShift {
  slug: string
  phase: number
  timeframe: number
  proposed_baseline: string | number
  current_baseline: string | number
}

/**
 * A sustained downward count level-shift beyond the automatic floor
 * (lib/ingest/staging/count-check.ts SHIFT_MAX_AUTO_DROP_PCT) keeps failing the
 * count check until an operator confirms the new level. Surface every
 * (source, timeframe) whose latest snapshot is waiting, on its own cooldown key.
 */
export async function alertPendingCountShifts(redis: Parameters<typeof alert>[0]): Promise<number> {
  const { rows } = await getIngestPool().query<PendingCountShift>(
    `SELECT s.slug, s.phase, latest.timeframe,
            latest.meta->'count_shift_pending'->>'proposed_baseline' AS proposed_baseline,
            latest.meta->'count_shift_pending'->>'current_baseline' AS current_baseline
       FROM arena.sources AS s
       JOIN LATERAL (
         SELECT DISTINCT ON (snapshot.timeframe) snapshot.timeframe, snapshot.meta
           FROM arena.leaderboard_snapshots AS snapshot
          WHERE snapshot.source_id = s.id
            AND snapshot.scraped_at > now() - interval '24 hours'
          ORDER BY snapshot.timeframe, snapshot.scraped_at DESC, snapshot.id DESC
       ) AS latest ON latest.meta ? 'count_shift_pending'
      WHERE s.status = 'active'`
  )
  for (const row of rows) {
    await alert(redis, {
      sourceSlug: `${row.slug}:count-shift:${row.timeframe}`,
      phase: row.phase,
      tier: 'A',
      message:
        `${row.timeframe}d board held at baseline ${row.current_baseline}: ` +
        `${row.proposed_baseline} rows for 3 consecutive cycles (possible truncation). ` +
        `Confirm a genuinely smaller board by setting arena.sources.meta.count_shift_ack.` +
        `${row.timeframe} = ${row.proposed_baseline}`,
    })
  }
  return rows.length
}
