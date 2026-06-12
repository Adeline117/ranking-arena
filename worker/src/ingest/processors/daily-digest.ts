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

/**
 * Coverage self-audit (root-of-root guard, 2026-06-12): the same checks as
 * scripts/qa/pipeline-coverage-audit.mjs, run on a timer so silent breaks
 * surface WITHOUT anyone remembering to run a script. Catches the class that
 * hid for hours: STALE sources (Tier-A not producing — e.g. the worker was
 * being OOM-restarted mid-crawl) and active sources with no passed snapshot.
 * LOW-SERIES is intentionally excluded (grows over cycles, has its backfill).
 */
async function queueCoverageAudit(): Promise<void> {
  const redis = getConnection()
  const { rows } = await getIngestPool().query<{
    slug: string
    phase: number
    serving_mode: string
    passed_tfs: number
    expected_tfs: number
    age_hours: number | null
  }>(
    `SELECT s.slug, s.phase, s.serving_mode,
       (SELECT count(DISTINCT ls.timeframe) FROM arena.leaderboard_snapshots ls
          WHERE ls.source_id = s.id AND ls.count_check_passed)::int AS passed_tfs,
       cardinality(ARRAY(
         SELECT DISTINCT unnest(s.timeframes_native || s.timeframes_derived)
         INTERSECT SELECT unnest(ARRAY[7,30,90]))) AS expected_tfs,
       EXTRACT(EPOCH FROM (now() - (
         SELECT max(ls.scraped_at) FROM arena.leaderboard_snapshots ls
          WHERE ls.source_id = s.id AND ls.count_check_passed))) / 3600 AS age_hours
     FROM arena.sources s
     WHERE s.status = 'active'`
  )
  for (const r of rows) {
    const issues: string[] = []
    if (r.passed_tfs === 0) issues.push('NO-PASSED-SNAPSHOT')
    else if (r.passed_tfs < Math.min(r.expected_tfs, 3))
      issues.push(`PARTIAL-TF(${r.passed_tfs}/${r.expected_tfs})`)
    // Stale = older than 3× the typical 5-6h Tier-A cadence.
    if (r.age_hours !== null && r.age_hours > 18) issues.push(`STALE(${r.age_hours.toFixed(0)}h)`)
    if (issues.length === 0) continue
    await alert(redis, {
      sourceSlug: r.slug,
      phase: r.phase,
      // serving sources serving stale/no data is more urgent than shadow.
      tier:
        r.serving_mode === 'serving' && issues.some((i) => i.startsWith('STALE')) ? 'A' : 'maint',
      message: `coverage: ${issues.join(', ')}`,
    })
  }
}

/**
 * Worker-health watchdog: a process being OOM/crash-restarted repeatedly is
 * the single most damaging silent failure (it kills in-flight 25-90min
 * crawls), and nothing surfaced it for 15h / 28 restarts. Read PM2's restart
 * counter from its dump and flag abnormal churn.
 */
async function queueWorkerHealth(): Promise<void> {
  const redis = getConnection()
  try {
    const { readFile } = await import('node:fs/promises')
    const { homedir } = await import('node:os')
    const dump = JSON.parse(await readFile(`${homedir()}/.pm2/dump.pm2`, 'utf8')) as Array<{
      name: string
      pm2_env?: { restart_time?: number; created_at?: number }
    }>
    for (const app of dump) {
      if (!app.name?.startsWith('arena-ingest')) continue
      const restarts = app.pm2_env?.restart_time ?? 0
      const createdAt = app.pm2_env?.created_at
      if (!createdAt) continue
      const hours = (Date.now() - createdAt) / 3.6e6
      // >1 restart/hour sustained = crash loop / OOM churn.
      if (hours > 2 && restarts / hours > 1) {
        await alert(redis, {
          sourceSlug: app.name,
          phase: 0,
          tier: 'A', // worker churn pages — it silently kills crawls
          message: `worker restart churn: ${restarts} restarts in ${hours.toFixed(0)}h (OOM?)`,
        })
      }
    }
  } catch (err) {
    console.warn('[daily-digest] worker-health probe skipped:', err)
  }
}

/**
 * Suspicious-eviction detector: a snapshot whose count is WITHIN tolerance
 * yet count_check_passed=false and NOT tagged meta.smoke was almost
 * certainly hand-evicted by a bare `UPDATE ... SET count_check_passed=false`
 * (the old smoke SOP that bypassed the --smoke flag's meta tag) — which
 * buried real full-crawl snapshots (bitunix 4025/4005, blofin). Surface
 * them so they can be restored instead of silently rotting.
 */
async function queueSuspiciousEvictions(): Promise<void> {
  const redis = getConnection()
  const { rows } = await getIngestPool().query<{ slug: string; phase: number; n: number }>(
    `SELECT s.slug, s.phase, count(*)::int AS n
       FROM arena.leaderboard_snapshots ls
       JOIN arena.sources s ON s.id = ls.source_id
      WHERE NOT ls.count_check_passed
        AND (ls.meta->>'smoke') IS NULL
        AND ls.baseline_used IS NOT NULL
        AND abs(ls.actual_count - ls.baseline_used)::numeric
              / NULLIF(ls.baseline_used, 0) <= 0.10
        AND ls.scraped_at > now() - interval '7 days'
        -- only flag if the source currently has NO passed snapshot for that TF
        AND NOT EXISTS (
          SELECT 1 FROM arena.leaderboard_snapshots p
           WHERE p.source_id = ls.source_id AND p.timeframe = ls.timeframe
             AND p.count_check_passed)
      GROUP BY s.slug, s.phase`
  )
  for (const r of rows) {
    await alert(redis, {
      sourceSlug: r.slug,
      phase: r.phase,
      tier: 'maint',
      message: `${r.n} in-tolerance snapshot(s) evicted without smoke tag — likely buried real data, review for restore`,
    })
  }
}

/**
 * Orphan-partition watchdog (root-cause guard, 2026-06-12): twice during the
 * rebuild an old monthly partition was DETACHed from its parent to stop the
 * legacy pipeline / swap in a renamed partitioned table, but never DROPped —
 * leaving standalone orphan tables that no live query can reach (the parent
 * only sees attached partitions) yet still cost storage. trader_snapshots_v2
 * Apr+May alone were ~15GB of invisible dead weight. There is no automated
 * DETACH process, so this is leftover-detection, not a recurring-job alarm:
 * flag any partition-shaped table (name ends _YYYY_MM / _pYYYY_MM) that is
 * attached to NO parent and exceeds 100MB, so the next orphan gets reviewed
 * for DROP instead of silently rotting.
 */
async function queueOrphanPartitions(): Promise<void> {
  const redis = getConnection()
  const { rows } = await getIngestPool().query<{ orphan: string; size: string; bytes: number }>(
    `SELECT n.nspname || '.' || c.relname AS orphan,
            pg_size_pretty(pg_total_relation_size(c.oid)) AS size,
            pg_total_relation_size(c.oid) AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind = 'r'
        AND n.nspname IN ('public','arena')
        AND c.relname ~ '_p?[0-9]{4}_[0-9]{2}$'
        AND NOT EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid)
        AND pg_total_relation_size(c.oid) > 100 * 1024 * 1024
      ORDER BY pg_total_relation_size(c.oid) DESC`
  )
  for (const r of rows) {
    await alert(redis, {
      sourceSlug: r.orphan,
      phase: 0,
      tier: 'maint', // cost hygiene, not an outage
      message: `detached orphan partition ${r.orphan} (${r.size}) — no parent, no live reads; review for DROP`,
    })
  }
}

export async function processDailyDigest(_job: Job): Promise<{ flushed: number }> {
  await queueRejectSummary()
  await queueCoverageAudit()
  await queueWorkerHealth()
  await queueSuspiciousEvictions()
  await queueOrphanPartitions()
  const flushed = await flushDigest(getConnection())
  console.log(`[daily-digest] flushed ${flushed} events`)
  return { flushed }
}
