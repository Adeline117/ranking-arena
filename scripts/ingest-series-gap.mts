/**
 * Measure the series-coverage gap per serving source.
 * For each serving source: ranked traders (latest passed snapshot, all TFs),
 * how many have any trader_stats, how many have any trader_series, topN.
 */
import { getIngestPool } from '../lib/ingest/db'

async function main() {
  const pool = getIngestPool()

  const { rows: sources } = await pool.query<{
    id: number
    slug: string
    serving_mode: string
    deep_profile_topn: number
    expected_count: number | null
    timeframes_native: number[]
    timeframes_derived: number[]
    meta: Record<string, unknown>
  }>(
    `SELECT id, slug, serving_mode, deep_profile_topn, expected_count,
            timeframes_native, timeframes_derived, meta
       FROM arena.sources
      WHERE serving_mode IN ('serving', 'shadow') AND status = 'active'
      ORDER BY serving_mode DESC, slug`
  )

  console.log(`\n=== SERVING SOURCES SERIES GAP (${sources.length} sources) ===\n`)
  console.log(
    'slug'.padEnd(22),
    'ranked'.padStart(7),
    'wStats'.padStart(7),
    'wSeries'.padStart(8),
    'series%'.padStart(8),
    'topN'.padStart(6),
    'native'.padStart(10)
  )
  console.log('-'.repeat(80))

  let totRanked = 0
  let totSeries = 0

  for (const s of sources) {
    // distinct ranked traders across latest passed snapshot per TF
    const { rows: r } = await pool.query<{
      ranked: number
      with_stats: number
      with_series: number
    }>(
      `WITH latest AS (
         SELECT DISTINCT ON (timeframe) id AS snapshot_id
           FROM arena.leaderboard_snapshots
          WHERE source_id = $1 AND count_check_passed
          ORDER BY timeframe, scraped_at DESC
       ),
       ranked AS (
         SELECT DISTINCT e.trader_id
           FROM latest l
           JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
       )
       SELECT
         (SELECT count(*) FROM ranked) AS ranked,
         (SELECT count(DISTINCT ts.trader_id)
            FROM arena.trader_stats ts
           WHERE ts.trader_id IN (SELECT trader_id FROM ranked)) AS with_stats,
         (SELECT count(DISTINCT se.trader_id)
            FROM arena.trader_series se
           WHERE se.trader_id IN (SELECT trader_id FROM ranked)) AS with_series`,
      [s.id]
    )
    const ranked = r[0]?.ranked ?? 0
    const withStats = r[0]?.with_stats ?? 0
    const withSeries = r[0]?.with_series ?? 0
    totRanked += ranked
    totSeries += withSeries
    const pct = ranked > 0 ? ((withSeries / ranked) * 100).toFixed(1) : '–'
    const backfillTopn = (s.meta?.series_backfill_topn as number | undefined) ?? null
    console.log(
      s.slug.padEnd(22),
      String(ranked).padStart(7),
      String(withStats).padStart(7),
      String(withSeries).padStart(8),
      `${pct}%`.padStart(8),
      String(s.deep_profile_topn).padStart(6),
      `[${s.timeframes_native}]`.padStart(10),
      backfillTopn ? `bf=${backfillTopn}` : ''
    )
  }
  console.log('-'.repeat(80))
  console.log(
    `TOTAL ranked=${totRanked} withSeries=${totSeries} (${((totSeries / totRanked) * 100).toFixed(1)}%)`
  )

  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
