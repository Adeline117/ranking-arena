#!/usr/bin/env node
/* eslint-disable no-console -- read-only operator probe intentionally prints its verdict table */
/**
 * Pipeline coverage audit — the "data flowed but nobody sees it" detector.
 *
 * WHY (root-cause guard, 2026-06-12): repeatedly during the rebuild, a
 * source was `active` in arena.sources yet produced NO user-visible data —
 * because an expected Tier-A window never yielded a PASSED snapshot, its
 * scored rows never reached the current leaderboard serving generation, or
 * ranked identities had no recent profile series.
 *
 * Unit tests and DB-row smokes do not catch this gap between "rows exist
 * somewhere" and "the ranking/profile read path has them". This script makes
 * every such silent break loud, per registry source and expected window.
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

const toNumber = (value) => (value === null || value === undefined ? 0 : Number(value))

function cacheState(window) {
  if (!window.generation_updated_at) return 'no-generation'
  if (!window.cache_updated_at) return 'missing'
  return window.cache_current === true ? 'current' : 'stale'
}

function windowLabel(window, detail) {
  return `${detail}(${window.season_id})`
}

async function main() {
  const client = new pg.Client({
    connectionString: url,
    ssl: url.includes('localhost') ? undefined : { rejectUnauthorized: false },
  })
  await client.connect()

  try {
    const { rows } = await client.query(`
      WITH source_base AS MATERIALIZED (
        SELECT
          source_row.id,
          source_row.slug,
          source_row.serving_mode,
          source_row.phase,
          source_row.currency,
          COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug)
            AS filter_source,
          ARRAY(
            SELECT DISTINCT timeframe
              FROM unnest(
                COALESCE(source_row.timeframes_native, ARRAY[]::integer[])
                || COALESCE(source_row.timeframes_derived, ARRAY[]::integer[])
              ) AS timeframe
             WHERE timeframe = ANY(ARRAY[7, 30, 90])
             ORDER BY timeframe
          ) AS expected_timeframes
          FROM arena.sources source_row
         WHERE source_row.status = 'active'
      ),
      source_windows AS MATERIALIZED (
        SELECT
          source_row.id AS source_id,
          source_row.filter_source,
          timeframe,
          timeframe::text || 'D' AS season_id
          FROM source_base source_row
         CROSS JOIN LATERAL unnest(source_row.expected_timeframes) AS timeframe
      ),
      passed_windows AS MATERIALIZED (
        SELECT
          source_window.source_id,
          source_window.season_id,
          max(snapshot.scraped_at) AS passed_at
          FROM source_windows source_window
          LEFT JOIN arena.leaderboard_snapshots snapshot
            ON snapshot.source_id = source_window.source_id
           AND snapshot.timeframe = source_window.timeframe
           AND snapshot.count_check_passed
         GROUP BY source_window.source_id, source_window.season_id
      ),
      rank_counts AS MATERIALIZED (
        SELECT
          rank_row.source,
          rank_row.season_id,
          count(*) FILTER (
            WHERE rank_row.arena_score > 0
              AND rank_row.is_outlier IS NOT TRUE
          ) AS scored_rows,
          count(*) FILTER (
            WHERE rank_row.arena_score > 0
              AND rank_row.is_outlier IS NOT TRUE
              AND rank_row.roi BETWEEN -50000 AND 50000
          ) AS api_rows,
          COUNT(DISTINCT (
            rank_row.source,
            CASE
              WHEN rank_row.source_trader_id LIKE '0x%'
                THEN lower(rank_row.source_trader_id)
              ELSE rank_row.source_trader_id
            END
          )) FILTER (
            WHERE rank_row.arena_score > 0
              AND rank_row.is_outlier IS NOT TRUE
              AND rank_row.roi BETWEEN -50000 AND 50000
          ) AS api_identities
          FROM public.leaderboard_ranks rank_row
         WHERE rank_row.season_id = ANY(ARRAY['7D', '30D', '90D'])
           AND rank_row.source IN (
             SELECT DISTINCT filter_source FROM source_windows
           )
         GROUP BY rank_row.source, rank_row.season_id
      ),
      cache_generation AS MATERIALIZED (
        SELECT season_id, updated_at
          FROM public.leaderboard_count_cache
         WHERE source = '_all_gt0'
           AND season_id = ANY(ARRAY['7D', '30D', '90D'])
      ),
      window_contract AS MATERIALIZED (
        SELECT
          source_window.source_id,
          source_window.season_id,
          passed.passed_at,
          COALESCE(rank_count.scored_rows, 0) AS scored_rows,
          COALESCE(rank_count.api_rows, 0) AS api_rows,
          COALESCE(rank_count.api_identities, 0) AS api_identities,
          cache_row.total_count AS cache_count,
          cache_row.updated_at AS cache_updated_at,
          generation.updated_at AS generation_updated_at,
          cache_row.updated_at = generation.updated_at AS cache_current
          FROM source_windows source_window
          LEFT JOIN passed_windows passed
            ON passed.source_id = source_window.source_id
           AND passed.season_id = source_window.season_id
          LEFT JOIN rank_counts rank_count
            ON rank_count.source = source_window.filter_source
           AND rank_count.season_id = source_window.season_id
          LEFT JOIN public.leaderboard_count_cache cache_row
            ON cache_row.season_id = source_window.season_id
           AND cache_row.source = source_window.filter_source || '_gt0'
          LEFT JOIN cache_generation generation
            ON generation.season_id = source_window.season_id
      ),
      source_contract AS (
        SELECT
          contract.source_id,
          jsonb_agg(
            jsonb_build_object(
              'season_id', contract.season_id,
              'passed_at', contract.passed_at,
              'scored_rows', contract.scored_rows,
              'api_rows', contract.api_rows,
              'api_identities', contract.api_identities,
              'cache_count', contract.cache_count,
              'cache_updated_at', contract.cache_updated_at,
              'generation_updated_at', contract.generation_updated_at,
              'cache_current', contract.cache_current
            )
            ORDER BY contract.season_id
          ) AS windows
          FROM window_contract contract
         GROUP BY contract.source_id
      ),
      ranked_identities AS MATERIALIZED (
        SELECT
          rank_row.source,
          rank_row.source_trader_id,
          max(rank_row.arena_score) AS arena_score
          FROM public.leaderboard_ranks rank_row
         WHERE rank_row.season_id = ANY(ARRAY['7D', '30D', '90D'])
           AND rank_row.arena_score > 0
           AND rank_row.is_outlier IS NOT TRUE
           AND rank_row.roi BETWEEN -50000 AND 50000
           AND rank_row.source IN (
             SELECT DISTINCT filter_source
               FROM source_base
              WHERE serving_mode = 'serving'
           )
         GROUP BY rank_row.source, rank_row.source_trader_id
      ),
      ranked_sample AS (
        SELECT source, source_trader_id
          FROM (
            SELECT
              ranked_identity.*,
              row_number() OVER (
                PARTITION BY ranked_identity.source
                ORDER BY ranked_identity.arena_score DESC NULLS LAST,
                         ranked_identity.source_trader_id
              ) AS sample_rank
              FROM ranked_identities ranked_identity
          ) ranked
         WHERE sample_rank <= 100
      ),
      series_sample AS MATERIALIZED (
        SELECT
          source_row.id AS source_id,
          ranked.source_trader_id,
          trader.id AS trader_id
          FROM source_base source_row
          JOIN ranked_sample ranked
            ON ranked.source = source_row.filter_source
          LEFT JOIN arena.traders trader
            ON trader.source_id = source_row.id
           AND trader.exchange_trader_id = ranked.source_trader_id
         WHERE source_row.serving_mode = 'serving'
      ),
      series_coverage AS (
        SELECT
          sample.source_id,
          count(*) AS sample_rows,
          count(sample.trader_id) AS profile_traders,
          count(*) FILTER (
            WHERE sample.trader_id IS NOT NULL
              AND EXISTS (
                SELECT 1
                  FROM arena.trader_series series
                 WHERE series.trader_id = sample.trader_id
                   AND series.ts > now() - interval '35 days'
                 LIMIT 1
              )
          ) AS series_traders
          FROM series_sample sample
         GROUP BY sample.source_id
      )
      SELECT
        source_row.slug,
        source_row.serving_mode,
        source_row.phase,
        source_row.currency,
        source_row.filter_source,
        cardinality(source_row.expected_timeframes) AS expected_tfs,
        COALESCE(source_contract.windows, '[]'::jsonb) AS windows,
        COALESCE(series_coverage.sample_rows, 0) AS series_sample_rows,
        COALESCE(series_coverage.profile_traders, 0) AS profile_traders,
        COALESCE(series_coverage.series_traders, 0) AS series_traders
        FROM source_base source_row
        LEFT JOIN source_contract ON source_contract.source_id = source_row.id
        LEFT JOIN series_coverage ON series_coverage.source_id = source_row.id
       ORDER BY source_row.phase, source_row.slug
    `)

    const now = Date.now()
    const breaks = []
    console.log(
      'source                  mode     passedTF  maxAge    seriesCov  api/cache       issues'
    )

    for (const row of rows) {
      const issues = []
      const windows = Array.isArray(row.windows) ? row.windows : []
      let passedWindows = 0
      let maxAgeHours = null
      let apiRows = 0
      let cacheRows = 0

      if (windows.length === 0) issues.push('NO-EXPECTED-TF')

      for (const window of windows) {
        const passedAt = window.passed_at ? new Date(window.passed_at).getTime() : null
        const ageHours = passedAt === null ? null : (now - passedAt) / 3.6e6
        const scored = toNumber(window.scored_rows)
        const api = toNumber(window.api_rows)
        const identities = toNumber(window.api_identities)
        const state = cacheState(window)
        const currentCache = state === 'current' ? toNumber(window.cache_count) : 0

        apiRows += api
        cacheRows += currentCache

        if (passedAt === null) {
          issues.push(windowLabel(window, 'NO-PASSED'))
        } else {
          passedWindows++
          maxAgeHours = maxAgeHours === null ? ageHours : Math.max(maxAgeHours, ageHours)
          if (ageHours > 12) {
            issues.push(windowLabel(window, `STALE:${ageHours.toFixed(0)}h`))
          }
        }

        if (row.serving_mode === 'serving') {
          if (api === 0 && passedAt !== null) {
            issues.push(windowLabel(window, 'NO-SERVING-RANKS'))
          }
          if (state === 'no-generation') {
            issues.push(windowLabel(window, 'NO-CACHE-GENERATION'))
          } else if (state === 'stale') {
            issues.push(windowLabel(window, 'STALE-CACHE'))
          } else if (state === 'missing' && scored > 0) {
            issues.push(windowLabel(window, 'NO-CACHE'))
          }
          if (currentCache !== scored) {
            issues.push(windowLabel(window, `CACHE-DIFF:${scored}/${currentCache}`))
          }
          if (api !== scored) {
            issues.push(windowLabel(window, `API-FILTER-DIFF:${api}/${scored}`))
          }
          if (identities !== api) {
            issues.push(windowLabel(window, `API-IDENTITY-COLLISION:${identities}/${api}`))
          }
        } else if (scored > 0 || currentCache > 0) {
          issues.push(windowLabel(window, `HIDDEN-MODE-RANKS:${scored}`))
        }
      }

      const sampleRows = toNumber(row.series_sample_rows)
      const profileTraders = toNumber(row.profile_traders)
      const seriesTraders = toNumber(row.series_traders)
      if (row.serving_mode === 'serving' && profileTraders !== sampleRows) {
        issues.push(`UNRESOLVED-PROFILES(${profileTraders}/${sampleRows})`)
      }
      const coverage = sampleRows > 0 ? seriesTraders / sampleRows : 1
      if (sampleRows > 0 && coverage < 0.1) {
        issues.push(`LOW-SERIES(${(coverage * 100).toFixed(0)}%)`)
      }

      // LOW-SERIES grows over crawl cycles (dedicated backfill) — it remains
      // informational in --soft mode. Missing snapshots, ranks, current cache,
      // registry isolation, and profile identities are hard serving breaks.
      const hardIssues = issues.filter((issue) => !issue.startsWith('LOW-SERIES'))
      const failingIssues = process.argv.includes('--soft') ? hardIssues : issues
      if (failingIssues.length) breaks.push(row.slug)

      const format = (value, width) => String(value).padEnd(width)
      console.log(
        format(row.slug, 22) +
          ' ' +
          format(row.serving_mode, 8) +
          ' ' +
          format(`${passedWindows}/${row.expected_tfs}`, 9) +
          ' ' +
          format(maxAgeHours === null ? '-' : `${maxAgeHours.toFixed(0)}h`, 9) +
          ' ' +
          format(`${seriesTraders}/${sampleRows}`, 10) +
          ' ' +
          format(`${apiRows}/${cacheRows}`, 15) +
          ' ' +
          (issues.length ? `❌ ${issues.join(',')}` : '✅')
      )
    }

    console.log(`\n${rows.length - breaks.length}/${rows.length} sources clean`)
    if (breaks.length) console.log('Breaks:', breaks.join(', '))
    process.exitCode = breaks.length ? 1 : 0
  } finally {
    await client.end()
  }
}

main().catch((error) => {
  console.error('FAILED:', error)
  process.exit(1)
})
