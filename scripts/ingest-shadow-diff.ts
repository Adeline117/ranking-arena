/* eslint-disable no-console -- read-only operator probe intentionally prints its verdict table */
/**
 * Canonical serving diff.
 *
 * The filename is retained because operators and `npm run qa:serving` already
 * call it, but there is no shadow/compat table after the Arena endgame cutover.
 * The production contract now has four parts:
 *
 *   1. public.leaderboard_ranks is keyed by
 *      (season_id, source, source_trader_id);
 *   2. score-visible rows have arena_score > 0 and are not outliers;
 *   3. /api/rankings additionally rejects ROI outside +/-50,000 and
 *      case-folds 0x identities while de-duplicating a response;
 *   4. totals come from the current leaderboard_count_cache `_gt0`
 *      generation and only registry-approved source/window pairs may serve.
 *
 * This read-only probe checks those parts against one another for every active
 * serving source matching a prefix. It detects stale/missing cache rows,
 * API-hidden scored rows, identity collisions, and ranked rows outside the
 * active serving registry.
 *
 * Usage: npx tsx scripts/ingest-shadow-diff.ts [source-prefix]
 *        (no prefix checks every active serving source)
 */
import { resolve } from 'path'
import { config } from 'dotenv'

config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

interface ServingDiffRow {
  registry_slug: string
  filter_source: string
  season_id: string
  registry_mappings: number | string
  scored_count: number | string
  api_count: number | string
  raw_identity_count: number | string
  api_identity_count: number | string
  cache_count: number | string | null
  cache_updated_at: Date | string | null
  generation_updated_at: Date | string | null
  cache_current: boolean | null
  latest_computed_at: Date | string | null
}

interface RegistryDriftRow {
  filter_source: string
  season_id: string
  scored_count: number | string
  api_count: number | string
  cache_count: number | string | null
}

interface ServingDiff {
  registry_slug: string
  filter_source: string
  season_id: string
  registry_mappings: number
  scored_count: number
  api_count: number
  raw_identity_count: number
  api_identity_count: number
  cache_count: number | null
  cache_updated_at: string | null
  generation_updated_at: string | null
  cache_current: boolean
  latest_computed_at: string | null
}

function toNumber(value: number | string | null | undefined): number {
  return value === null || value === undefined ? 0 : Number(value)
}

function toIso(value: Date | string | null): string | null {
  if (!value) return null
  return new Date(value).toISOString()
}

function normalizeDiff(row: ServingDiffRow): ServingDiff {
  return {
    registry_slug: row.registry_slug,
    filter_source: row.filter_source,
    season_id: row.season_id,
    registry_mappings: toNumber(row.registry_mappings),
    scored_count: toNumber(row.scored_count),
    api_count: toNumber(row.api_count),
    raw_identity_count: toNumber(row.raw_identity_count),
    api_identity_count: toNumber(row.api_identity_count),
    cache_count: row.cache_count === null ? null : Number(row.cache_count),
    cache_updated_at: toIso(row.cache_updated_at),
    generation_updated_at: toIso(row.generation_updated_at),
    cache_current: row.cache_current === true,
    latest_computed_at: toIso(row.latest_computed_at),
  }
}

function cacheState(diff: ServingDiff): string {
  if (!diff.generation_updated_at) return 'no-generation'
  if (!diff.cache_updated_at) return 'missing'
  return diff.cache_current ? 'current' : 'stale'
}

function verdictFor(diff: ServingDiff): { verdict: string; reason: string } {
  const reasons: string[] = []
  const state = cacheState(diff)
  const currentCacheCount = state === 'current' ? (diff.cache_count ?? 0) : 0

  if (diff.registry_mappings !== 1) {
    reasons.push(`REGISTRY-ALIAS-COLLISION(${diff.registry_mappings})`)
  }
  if (state === 'no-generation') reasons.push('NO-GENERATION')
  if (state === 'stale') reasons.push('STALE-CACHE')
  if (state === 'missing' && diff.scored_count > 0) reasons.push('NO-CACHE')
  if (currentCacheCount !== diff.scored_count) {
    reasons.push(`CACHE-DIFF(${diff.scored_count}/${currentCacheCount})`)
  }
  if (diff.api_count !== diff.scored_count) {
    reasons.push(`API-FILTER-DIFF(${diff.api_count}/${diff.scored_count})`)
  }
  if (diff.raw_identity_count !== diff.scored_count) {
    reasons.push(`COMPOSITE-IDENTITY-COLLISION(${diff.raw_identity_count}/${diff.scored_count})`)
  }
  if (diff.api_identity_count !== diff.api_count) {
    reasons.push(`API-IDENTITY-COLLISION(${diff.api_identity_count}/${diff.api_count})`)
  }

  if (reasons.length > 0) return { verdict: 'FAIL', reason: reasons.join(',') }
  if (diff.scored_count === 0) return { verdict: 'EMPTY', reason: '-' }
  return { verdict: 'PASS', reason: '-' }
}

async function main() {
  const prefix = process.argv[2] ?? ''
  const prefixPattern = `${prefix}%`
  const { getIngestPool, closeIngestPool } = await import('@/lib/ingest/db')
  const pool = getIngestPool()

  try {
    const { rows } = await pool.query<ServingDiffRow>(
      `WITH registry_rows AS MATERIALIZED (
         SELECT
           source_row.slug AS registry_slug,
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
           ) AS timeframes
           FROM arena.sources source_row
          WHERE source_row.status = 'active'
            AND source_row.serving_mode = 'serving'
            AND (
              source_row.slug LIKE $1
              OR COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug)
                LIKE $1
            )
       ),
       registry_windows AS MATERIALIZED (
         SELECT
           registry.registry_slug,
           registry.filter_source,
           timeframe::text || 'D' AS season_id,
           count(*) OVER (
             PARTITION BY registry.filter_source, timeframe
           ) AS registry_mappings
           FROM registry_rows registry
          CROSS JOIN LATERAL unnest(registry.timeframes) AS timeframe
       ),
       rank_counts AS MATERIALIZED (
         SELECT
           rank_row.source,
           rank_row.season_id,
           count(*) FILTER (
             WHERE rank_row.arena_score > 0
               AND rank_row.is_outlier IS NOT TRUE
           ) AS scored_count,
           count(*) FILTER (
             WHERE rank_row.arena_score > 0
               AND rank_row.is_outlier IS NOT TRUE
               AND rank_row.roi BETWEEN -50000 AND 50000
           ) AS api_count,
           COUNT(DISTINCT (rank_row.source, rank_row.source_trader_id)) FILTER (
             WHERE rank_row.arena_score > 0
               AND rank_row.is_outlier IS NOT TRUE
           ) AS raw_identity_count,
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
           ) AS api_identity_count,
           max(rank_row.computed_at) FILTER (
             WHERE rank_row.arena_score > 0
               AND rank_row.is_outlier IS NOT TRUE
           ) AS latest_computed_at
           FROM public.leaderboard_ranks rank_row
          WHERE rank_row.season_id = ANY(ARRAY['7D', '30D', '90D'])
            AND rank_row.source IN (
              SELECT DISTINCT filter_source FROM registry_windows
            )
          GROUP BY rank_row.source, rank_row.season_id
       ),
       cache_generation AS MATERIALIZED (
         SELECT season_id, updated_at
           FROM public.leaderboard_count_cache
          WHERE source = '_all_gt0'
            AND season_id = ANY(ARRAY['7D', '30D', '90D'])
       )
       SELECT
         registry.registry_slug,
         registry.filter_source,
         registry.season_id,
         registry.registry_mappings,
         COALESCE(rank_count.scored_count, 0) AS scored_count,
         COALESCE(rank_count.api_count, 0) AS api_count,
         COALESCE(rank_count.raw_identity_count, 0) AS raw_identity_count,
         COALESCE(rank_count.api_identity_count, 0) AS api_identity_count,
         cache_row.total_count AS cache_count,
         cache_row.updated_at AS cache_updated_at,
         generation.updated_at AS generation_updated_at,
         cache_row.updated_at = generation.updated_at AS cache_current,
         rank_count.latest_computed_at
         FROM registry_windows registry
         LEFT JOIN rank_counts rank_count
           ON rank_count.source = registry.filter_source
          AND rank_count.season_id = registry.season_id
         LEFT JOIN public.leaderboard_count_cache cache_row
           ON cache_row.season_id = registry.season_id
          AND cache_row.source = registry.filter_source || '_gt0'
         LEFT JOIN cache_generation generation
           ON generation.season_id = registry.season_id
        ORDER BY registry.registry_slug, registry.season_id`,
      [prefixPattern]
    )

    // A valid source alias is not enough: a rank/cache row must also belong
    // to one of that source's declared 7D/30D/90D windows. This catches stale
    // rows left behind after a source is retired, hidden, or narrows its
    // supported timeframe set.
    const { rows: registryDrift } = await pool.query<RegistryDriftRow>(
      `WITH allowed_windows AS MATERIALIZED (
         SELECT DISTINCT
           COALESCE(NULLIF(source_row.meta->>'legacy_platform', ''), source_row.slug)
             AS filter_source,
           timeframe::text || 'D' AS season_id
           FROM arena.sources source_row
          CROSS JOIN LATERAL unnest(
            COALESCE(source_row.timeframes_native, ARRAY[]::integer[])
            || COALESCE(source_row.timeframes_derived, ARRAY[]::integer[])
          ) AS timeframe
          WHERE source_row.status = 'active'
            AND source_row.serving_mode = 'serving'
            AND timeframe = ANY(ARRAY[7, 30, 90])
       ),
       scored_windows AS (
         SELECT
           rank_row.source AS filter_source,
           rank_row.season_id,
           count(*) AS scored_count,
           count(*) FILTER (
             WHERE rank_row.roi BETWEEN -50000 AND 50000
           ) AS api_count
           FROM public.leaderboard_ranks rank_row
          WHERE rank_row.season_id = ANY(ARRAY['7D', '30D', '90D'])
            AND rank_row.source LIKE $1
            AND rank_row.arena_score > 0
            AND rank_row.is_outlier IS NOT TRUE
          GROUP BY rank_row.source, rank_row.season_id
       ),
       generation AS (
         SELECT season_id, updated_at
           FROM public.leaderboard_count_cache
          WHERE source = '_all_gt0'
       ),
       cached_windows AS (
         SELECT
           left(cache_row.source, length(cache_row.source) - length('_gt0')) AS filter_source,
           cache_row.season_id,
           cache_row.total_count AS cache_count
           FROM public.leaderboard_count_cache cache_row
           JOIN generation
             ON generation.season_id = cache_row.season_id
            AND generation.updated_at = cache_row.updated_at
          WHERE cache_row.source <> '_all_gt0'
            AND cache_row.source LIKE '%\\_gt0' ESCAPE '\\'
            AND left(cache_row.source, length(cache_row.source) - length('_gt0')) LIKE $1
            AND cache_row.total_count > 0
       ),
       actual_windows AS (
         SELECT
           COALESCE(scored.filter_source, cached.filter_source) AS filter_source,
           COALESCE(scored.season_id, cached.season_id) AS season_id,
           COALESCE(scored.scored_count, 0) AS scored_count,
           COALESCE(scored.api_count, 0) AS api_count,
           cached.cache_count
           FROM scored_windows scored
           FULL OUTER JOIN cached_windows cached
             ON cached.filter_source = scored.filter_source
            AND cached.season_id = scored.season_id
       )
       SELECT actual.*
         FROM actual_windows actual
         LEFT JOIN allowed_windows allowed
           ON allowed.filter_source = actual.filter_source
          AND allowed.season_id = actual.season_id
        WHERE allowed.filter_source IS NULL
        ORDER BY actual.filter_source, actual.season_id`,
      [prefixPattern]
    )

    if (rows.length === 0 && registryDrift.length === 0) {
      console.log(`No active serving sources or ranked drift matching '${prefixPattern}'.`)
      return
    }

    console.log(`Serving rank/cache diff: ${rows.length} registry window(s)\n`)

    const outputRows: string[][] = []
    let anyFail = false

    for (const row of rows) {
      const diff = normalizeDiff(row)
      const { verdict, reason } = verdictFor(diff)
      if (verdict === 'FAIL') anyFail = true

      outputRows.push([
        diff.registry_slug,
        diff.filter_source,
        diff.season_id,
        String(diff.scored_count),
        String(diff.api_count),
        String(diff.cache_count ?? 0),
        `${diff.raw_identity_count}/${diff.api_identity_count}`,
        cacheState(diff),
        diff.latest_computed_at ?? '-',
        verdict,
        reason,
      ])
    }

    for (const row of registryDrift) {
      anyFail = true
      outputRows.push([
        '-',
        row.filter_source,
        row.season_id,
        String(toNumber(row.scored_count)),
        String(toNumber(row.api_count)),
        String(toNumber(row.cache_count)),
        '-',
        'current',
        '-',
        'FAIL',
        'UNREGISTERED-WINDOW',
      ])
    }

    const headers = [
      'registry',
      'source',
      'window',
      'scored',
      'api',
      'cache',
      'ids(raw/api)',
      'cache-state',
      'computed_at',
      'verdict',
      'reason',
    ]
    const widths = headers.map((header, index) =>
      Math.max(header.length, ...outputRows.map((row) => row[index].length))
    )
    const formatRow = (row: string[]) =>
      row.map((cell, index) => cell.padEnd(widths[index])).join('  ')

    console.log(formatRow(headers))
    console.log(widths.map((width) => '-'.repeat(width)).join('  '))
    for (const row of outputRows) console.log(formatRow(row))

    console.log(
      `\nVerdict: ${
        anyFail
          ? 'FAIL — registry, leaderboard rows, API visibility, identity, or current count cache diverge'
          : 'PASS — leaderboard rows match the active registry and API-visible current cache contract'
      }`
    )
    console.log(
      '(EMPTY = an expected source/window currently has no score-visible row and no cache row; ' +
        'pipeline-coverage-audit owns missing-snapshot and empty-window detection.)'
    )

    process.exitCode = anyFail ? 1 : 0
  } finally {
    await closeIngestPool()
  }
}

main().catch((error) => {
  console.error('FAILED:', error)
  process.exit(1)
})
