#!/usr/bin/env node
/**
 * Pipeline coverage audit — the "data flowed but nobody sees it" detector.
 *
 * WHY (root-cause guard, 2026-06-12): repeatedly during the rebuild, a
 * source was `active` in arena.sources yet produced NO user-visible data —
 * because its scheduled Tier-A never yielded a PASSED snapshot (smoke
 * snapshots evicted, count-check gated, crawl failing), or it was in
 * `shadow` mode but the compat dual-write into trader_latest hadn't run.
 * Unit tests and DB-row smokes don't catch this — the gap is BETWEEN
 * "rows exist somewhere" and "the serving/ranking read path has them".
 * This script makes every such silent break loud.
 *
 * Pure read-only. Run anytime; safe alongside crawls.
 *   node scripts/qa/pipeline-coverage-audit.mjs
 * Exit 1 if any active source has a coverage break.
 */
import pg from 'pg'
import { config } from 'dotenv'
import { resolve } from 'path'

config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

const url = process.env.INGEST_DATABASE_URL || process.env.DATABASE_URL
if (!url) {
  console.error('INGEST_DATABASE_URL not set')
  process.exit(2)
}
const client = new pg.Client({
  connectionString: url,
  ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
})
await client.connect()

const { rows } = await client.query(`
  SELECT
    s.slug, s.serving_mode, s.phase, s.currency,
    -- arena: latest passed snapshot freshness
    (SELECT max(ls.scraped_at) FROM arena.leaderboard_snapshots ls
       WHERE ls.source_id = s.id AND ls.count_check_passed) AS arena_passed_at,
    (SELECT count(DISTINCT ls.timeframe) FROM arena.leaderboard_snapshots ls
       WHERE ls.source_id = s.id AND ls.count_check_passed) AS passed_tfs,
    -- expected TFs = native ∪ derived, capped to the 7/30/90 ranking set
    -- (derived boards like MEXC 30/90 also produce passed snapshots).
    cardinality(ARRAY(
      SELECT DISTINCT unnest(s.timeframes_native || s.timeframes_derived)
      INTERSECT SELECT unnest(ARRAY[7,30,90])
    )) AS native_tfs,
    -- series coverage (the empty-chart driver)
    (SELECT count(*) FROM arena.trader_stats st
       JOIN arena.traders t ON t.id = st.trader_id WHERE t.source_id = s.id) AS stats_rows,
    (SELECT count(DISTINCT ts.trader_id) FROM arena.trader_series ts
       JOIN arena.traders t ON t.id = ts.trader_id WHERE t.source_id = s.id) AS series_traders,
    -- compat into legacy ranking layer (shadow/serving must dual-write)
    (SELECT count(*) FROM public.trader_latest tl
       WHERE tl.platform = COALESCE(s.meta->>'legacy_platform', s.slug)
         AND tl.provenance->>'pipeline' = 'arena_ingest_v2') AS compat_rows
  FROM arena.sources s
  WHERE s.status = 'active'
  ORDER BY s.phase, s.slug
`)

const now = Date.now()
const breaks = []
console.log('source                  mode     passedTF  arenaAge  seriesCov  compat   issues')
for (const r of rows) {
  const issues = []
  const ageH = r.arena_passed_at ? (now - new Date(r.arena_passed_at).getTime()) / 3.6e6 : null
  // 1. active but no passed snapshot at all
  if (r.passed_tfs === 0) issues.push('NO-PASSED-SNAPSHOT')
  // 2. some but not all native TFs have passed
  else if (r.passed_tfs < Math.min(r.native_tfs, 3))
    issues.push(`PARTIAL-TF(${r.passed_tfs}/${r.native_tfs})`)
  // 3. stale: latest passed snapshot older than 12h
  if (ageH !== null && ageH > 12) issues.push(`STALE(${ageH.toFixed(0)}h)`)
  // 4. shadow/serving but no compat rows in the ranking layer
  if (r.serving_mode !== 'legacy' && r.compat_rows === 0 && r.passed_tfs > 0) {
    issues.push('NO-COMPAT')
  }
  // 5. series coverage <10% of stats (empty charts for most clickable traders)
  const cov = r.stats_rows > 0 ? r.series_traders / r.stats_rows : 1
  if (r.stats_rows > 100 && cov < 0.1) issues.push(`LOW-SERIES(${(cov * 100).toFixed(0)}%)`)

  // LOW-SERIES grows over crawl cycles (dedicated backfill) — it's a
  // coverage signal, not an outage. In --soft mode (acceptance gate) it
  // doesn't fail the run; hard breaks (no snapshot / no compat / stale)
  // always do.
  const hardIssues = issues.filter((i) => !i.startsWith('LOW-SERIES'))
  const failingIssues = process.argv.includes('--soft') ? hardIssues : issues
  if (failingIssues.length) breaks.push(r.slug)
  const fmt = (v, w) => String(v).padEnd(w)
  console.log(
    fmt(r.slug, 22) +
      ' ' +
      fmt(r.serving_mode, 8) +
      ' ' +
      fmt(`${r.passed_tfs}/${r.native_tfs}`, 9) +
      ' ' +
      fmt(ageH === null ? '-' : ageH.toFixed(0) + 'h', 9) +
      ' ' +
      fmt(`${r.series_traders}/${r.stats_rows}`, 10) +
      ' ' +
      fmt(r.compat_rows, 8) +
      ' ' +
      (issues.length ? '❌ ' + issues.join(',') : '✅')
  )
}

await client.end()
console.log(`\n${rows.length - breaks.length}/${rows.length} sources clean`)
if (breaks.length) console.log('Breaks:', breaks.join(', '))
process.exit(breaks.length ? 1 : 0)
