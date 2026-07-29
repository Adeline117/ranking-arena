/**
 * Cron: Precompute composite rankings and store in Redis
 * Schedule: Every 2 hours (see vercel.json cron config)
 *
 * Composite = weighted average of 7D/30D/90D arena_score:
 *   7D*0.05 + 30D*0.25 + 90D*0.70
 * Unified with OVERALL_WEIGHTS in lib/utils/arena-score.ts (2026-03-13)
 *
 * Result stored in Redis with 3h TTL so /api/rankings?window=composite
 * can serve from cache in ~5ms instead of ~500ms real-time compute.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getPool } from '@/lib/db'
import { tieredSet } from '@/lib/cache/redis-layer'
import {
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import { readSealedCompositePublicationFence } from '@/lib/rankings/read-sealed-composite-publications'
import { createSealedCompositeCacheEntry } from '@/lib/rankings/sealed-composite-cache'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'
import { PLATFORM_CATEGORY } from '@/lib/types/leaderboard'
import type { GranularPlatform } from '@/lib/types/leaderboard'
import { ARENA_CONFIG } from '@/lib/utils/arena-score'
import { createLogger } from '@/lib/utils/logger'
import { PipelineLogger } from '@/lib/services/pipeline-logger'
import { verifyCronSecret } from '@/lib/auth/verify-service-auth'
import { acquireCronLock } from '@/lib/cron/with-cron-lock'
import {
  sourceFreshnessStatusMap,
  summarizeSourceFreshness,
  type SourceFreshnessRow,
} from '@/lib/rankings/source-freshness'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // Was 120 — consistently timing out since 2026-05-17 as DB grew

const logger = createLogger('precompute-composite')

// Single source of truth: lib/utils/arena-score.ts
const COMPOSITE_WEIGHTS = ARENA_CONFIG.OVERALL_WEIGHTS
const ROI_ANOMALY_THRESHOLD = 5000
const CACHE_TTL_SECONDS = 10800 // 3 hours (cron runs every 2h, overlap for safety)
const CACHE_STALE_WHILE_REVALIDATE_SECONDS = 300
const COMPOSITE_CACHE_VERSION = 'v3'

function compositeCategory(source: string): 'futures' | 'spot' | 'onchain' {
  return PLATFORM_CATEGORY[source as GranularPlatform] || 'futures'
}

// Statement timeout for the heavy per-window queries. Root cause fix: 90s was
// too short for 7D — the largest partition grew past what 90s could scan,
// causing 22+ "canceling statement due to statement timeout" alerts.
// 30s per window — trader_latest (45K rows) should complete in <1s.
// Previous value was 150s when querying trader_snapshots_v2 (10M+ rows).
// write, total max is ~500s — still within 300s maxDuration since actual p95
// for 90D+30D is <10s each, only 7D is slow at ~60-120s.
const WINDOW_QUERY_TIMEOUT_S = 30

interface SnapshotRow {
  platform: string
  trader_key: string
  as_of_ts: string | null
  computed_at: string | null
  arena_score: string | number | null
  roi_pct: string | number | null
  pnl_usd: string | number | null
  max_drawdown: string | number | null
  win_rate: string | number | null
  trades_count: number | null
  followers: number | null
  copiers: number | null
  sharpe_ratio: string | number | null
  sortino_ratio: string | number | null
  profitability_score: string | number | null
  risk_control_score: string | number | null
  execution_score: string | number | null
  score_completeness: string | null
  trading_style: string | null
  avg_holding_hours: string | number | null
  handle: string | null
  avatar_url: string | null
  trader_type: string | null
}

export async function GET(request: NextRequest) {
  if (!verifyCronSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const releaseLock = await acquireCronLock('precompute-composite', { ttlSeconds: 300 })
  if (!releaseLock) {
    return NextResponse.json({ status: 'skipped', reason: 'already running' })
  }

  const startTime = Date.now()
  const plog = await PipelineLogger.start('precompute-composite')

  // Safety timeout: ensure plog gets closed before Vercel kills the function at maxDuration (300s).
  let plogFinalized = false
  const safetyTimer = setTimeout(async () => {
    if (plogFinalized) return
    plogFinalized = true
    try {
      await plog.error(new Error('Safety timeout: function approaching 300s limit'))
    } catch {
      /* best effort */
    }
  }, 280_000) // 280s safety margin for 300s maxDuration

  try {
    const publicationFence = await readSealedCompositePublicationFence(getSupabaseAdmin(), {
      timeoutMs: 10_000,
    })

    /**
     * Fetch top 2000 traders for a window using raw SQL via pg pool.
     * This bypasses PostgREST's 30s statement_timeout — we SET LOCAL to 90s.
     *
     * Key optimizations vs the old PostgREST query:
     * 1. SET LOCAL statement_timeout per transaction, not per connection.
     * 2. Source freshness comes from the sealed publication proof set; stale
     *    last-good ranks remain eligible and are labeled stale in the payload.
     * 3. roi_pct anomaly filter applied in-app after index scan (avoids recheck on every row)
     * 4. Uses the season/arena_score leaderboard index.
     */
    const fetchWindow = async (seasonId: LeaderboardPublicationSeason): Promise<SnapshotRow[]> => {
      const publication = publicationFence.publicationFor(seasonId)
      const seasonSources = publicationFence.sourcesFor(seasonId)
      const proofBySource = new Map(
        publication.proofs.map((proof) => [proof.source, proof] as const)
      )
      const client = await getPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL statement_timeout = '${WINDOW_QUERY_TIMEOUT_S}s'`)

        // Read one exact sealed score cohort. Public source watermarks come
        // from the same publication proofs rather than a mutable side table.
        const result = await client.query<SnapshotRow>(
          `SELECT ranks.source AS platform, ranks.source_trader_id AS trader_key,
                  NULL::text AS as_of_ts, ranks.computed_at, ranks.arena_score,
                  ranks.roi AS roi_pct, ranks.pnl AS pnl_usd, ranks.max_drawdown,
                  ranks.win_rate, ranks.trades_count, ranks.followers, ranks.copiers,
                  ranks.sharpe_ratio, ranks.sortino_ratio, ranks.profitability_score,
                  ranks.risk_control_score, ranks.execution_score, ranks.score_completeness,
                  ranks.trading_style, ranks.avg_holding_hours, ranks.handle,
                  ranks.avatar_url, ranks.trader_type
           FROM leaderboard_ranks AS ranks
           WHERE ranks.season_id = $1
             AND ranks.rank_publication_id = $2::uuid
             AND ranks.source = ANY($3::text[])
             AND ranks.arena_score > 0
             AND ranks.roi IS NOT NULL
             AND (ranks.is_outlier IS NULL OR ranks.is_outlier = false)
           ORDER BY ranks.arena_score DESC NULLS LAST,
                    ranks.source ASC,
                    ranks.source_trader_id ASC
           LIMIT 2500`,
          [seasonId, publication.scoreCohortId, seasonSources]
        )

        await client.query('COMMIT')

        // Apply roi_pct anomaly filter in app code — avoids defeating index usage
        // in Postgres (the index covers window + arena_score, not roi_pct).
        // Fetch 2500 from DB to have headroom after filtering.
        const rows = (result.rows || []).map((row) => {
          if (
            !isPublicRankingSourceAllowed(row.platform) ||
            !seasonSources.includes(row.platform)
          ) {
            throw new Error(`Sealed ${seasonId} composite query returned a non-public source`)
          }
          const proof = proofBySource.get(row.platform)
          if (!proof) {
            throw new Error(`Sealed ${seasonId} composite query returned an unproved source`)
          }
          return { ...row, as_of_ts: proof.source_as_of }
        })
        const expectedRowCount = Math.min(
          2500,
          publication.proofs.reduce((total, proof) => total + proof.published_rank_count, 0)
        )
        if (rows.length !== expectedRowCount) {
          throw new Error(
            `Sealed ${seasonId} composite query read ${rows.length} of ${expectedRowCount} expected rows`
          )
        }

        const filtered = rows
          .map((row) => {
            if (
              row.roi_pct === null ||
              !Number.isFinite(typeof row.roi_pct === 'string' ? Number(row.roi_pct) : row.roi_pct)
            ) {
              throw new Error(`Sealed ${seasonId} composite query returned an invalid ROI`)
            }
            const score =
              typeof row.arena_score === 'string' ? Number(row.arena_score) : row.arena_score
            if (score === null || !Number.isFinite(score) || score <= 0 || score > 100) {
              throw new Error(`Sealed ${seasonId} composite query returned an invalid score`)
            }
            return row
          })
          .filter((r) => {
            const roi = typeof r.roi_pct === 'string' ? Number(r.roi_pct) : r.roi_pct!
            return roi >= -ROI_ANOMALY_THRESHOLD && roi <= ROI_ANOMALY_THRESHOLD
          })
        return filtered.slice(0, 2000)
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw new Error(
          `Fetch ${seasonId} failed: ${err instanceof Error ? err.message : String(err)}`
        )
      } finally {
        client.release()
      }
    }

    // Fetch sequentially to avoid concurrent connection exhaustion.
    // 7D is now the bottleneck (largest active partition scan).
    const rows7d = await fetchWindow('7D')
    const rows30d = await fetchWindow('30D')
    const rows90d = await fetchWindow('90D')

    // Build maps keyed by platform:trader_key
    const buildMap = (rows: SnapshotRow[]) => {
      const m = new Map<string, SnapshotRow>()
      for (const r of rows) {
        const tid = r.trader_key?.startsWith('0x') ? r.trader_key.toLowerCase() : r.trader_key
        const key = `${r.platform}:${tid}`
        if (m.has(key)) {
          throw new Error(`Sealed composite query returned duplicate identity ${key}`)
        }
        m.set(key, r)
      }
      return m
    }

    const map7d = buildMap(rows7d)
    const map30d = buildMap(rows30d)
    const map90d = buildMap(rows90d)

    // Union all trader keys
    const allKeys = new Set<string>()
    for (const m of [map7d, map30d, map90d]) {
      for (const k of m.keys()) allKeys.add(k)
    }

    // Compute weighted scores
    interface CompositeEntry {
      key: string
      platform: string
      trader_key: string
      compositeScore: number
      primaryRow: SnapshotRow
    }

    const entries: CompositeEntry[] = []
    for (const key of allKeys) {
      const r7 = map7d.get(key)
      const r30 = map30d.get(key)
      const r90 = map90d.get(key)

      const getScore = (r: SnapshotRow | undefined) => {
        if (!r) return null
        const v2 = r.arena_score != null ? parseFloat(r.arena_score as string) : null
        return v2 != null ? Math.min(v2, 100) : null
      }

      const s7 = getScore(r7)
      const s30 = getScore(r30)
      const s90 = getScore(r90)

      if (s7 == null && s30 == null && s90 == null) continue

      let totalWeight = 0
      let weightedSum = 0
      if (s7 != null) {
        weightedSum += s7 * COMPOSITE_WEIGHTS['7D']
        totalWeight += COMPOSITE_WEIGHTS['7D']
      }
      if (s30 != null) {
        weightedSum += s30 * COMPOSITE_WEIGHTS['30D']
        totalWeight += COMPOSITE_WEIGHTS['30D']
      }
      if (s90 != null) {
        weightedSum += s90 * COMPOSITE_WEIGHTS['90D']
        totalWeight += COMPOSITE_WEIGHTS['90D']
      }

      const compositeScore = totalWeight > 0 ? Math.min(weightedSum / totalWeight, 100) : 0
      const primaryRow = r90 || r30 || r7!
      const [platform, ...rest] = key.split(':')
      const trader_key = rest.join(':')

      entries.push({ key, platform, trader_key, compositeScore, primaryRow })
    }

    // Sort by composite score desc
    entries.sort((a, b) => b.compositeScore - a.compositeScore)

    const authoritySources = [
      ...new Set(
        (['7D', '30D', '90D'] as const).flatMap((season) => [
          ...publicationFence.sourcesFor(season),
        ])
      ),
    ].sort()

    // A composite source is only as fresh as its oldest contributing window.
    // Missing watermarks stay null/stale; no score-compute timestamp fallback.
    const sourceCaptureState = new Map<string, { oldestMs: number; invalid: boolean }>()
    for (const season of ['7D', '30D', '90D'] as const) {
      for (const proof of publicationFence.publicationFor(season).proofs) {
        const timestamp = Date.parse(proof.source_as_of)
        const current = sourceCaptureState.get(proof.source)
        sourceCaptureState.set(proof.source, {
          oldestMs: Number.isFinite(timestamp)
            ? Math.min(current?.oldestMs ?? timestamp, timestamp)
            : (current?.oldestMs ?? Number.POSITIVE_INFINITY),
          invalid: (current?.invalid ?? false) || !Number.isFinite(timestamp),
        })
      }
    }
    const sourceWatermarks: SourceFreshnessRow[] = authoritySources.map((source) => {
      const state = sourceCaptureState.get(source)
      return {
        source,
        source_as_of: state && !state.invalid ? new Date(state.oldestMs).toISOString() : null,
      }
    })
    const freshnessSummary = summarizeSourceFreshness(sourceWatermarks, authoritySources)
    const freshnessBySource = sourceFreshnessStatusMap(freshnessSummary)

    const numberOrNull = (value: string | number | null): number | null => {
      if (value === null) return null
      const parsed = typeof value === 'number' ? value : Number(value)
      return Number.isFinite(parsed) ? parsed : null
    }

    // Build the complete in-memory union before taking top-1000 slices. This
    // keeps category/platform caches honest even when their best trader falls
    // below the global top 1000.
    const allTraders = entries.map((entry, idx) => {
      const row = entry.primaryRow
      const sourceFreshness = freshnessBySource.get(entry.platform)
      const arenaScore = Math.round(entry.compositeScore * 10) / 10
      return {
        platform: entry.platform,
        trader_key: entry.trader_key,
        display_name: row.handle || null,
        avatar_url: row.avatar_url || null,
        roi: numberOrNull(row.roi_pct),
        pnl: numberOrNull(row.pnl_usd),
        arena_score: arenaScore,
        win_rate: numberOrNull(row.win_rate),
        max_drawdown: numberOrNull(row.max_drawdown),
        sharpe_ratio: numberOrNull(row.sharpe_ratio),
        sortino_ratio: numberOrNull(row.sortino_ratio),
        trades_count: row.trades_count ?? null,
        followers: row.followers ?? null,
        copiers: row.copiers ?? null,
        rank: idx + 1,
        quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 1.0 },
        updated_at: sourceFreshness?.updated_at ?? null,
        is_stale: sourceFreshness?.is_stale ?? true,
        computed_at: row.computed_at,
        profitability_score: numberOrNull(row.profitability_score),
        risk_control_score: numberOrNull(row.risk_control_score),
        execution_score: numberOrNull(row.execution_score),
        score_completeness: row.score_completeness,
        trading_style: row.trading_style,
        avg_holding_hours: numberOrNull(row.avg_holding_hours),
        style_confidence: null,
        is_bot:
          entry.platform === 'web3_bot' ||
          row.trader_type === 'bot' ||
          row.trader_type === 'suspected_bot',
        trader_type: row.trader_type || (entry.platform === 'web3_bot' ? 'bot' : null),
        category: compositeCategory(entry.platform),
      }
    })

    const buildCompositeData = (
      scopedTraders: typeof allTraders,
      scopedSources: readonly string[]
    ) => {
      const scopedFreshness = summarizeSourceFreshness(sourceWatermarks, scopedSources)
      const traders = scopedTraders.slice(0, 1000).map((trader, idx) => ({
        ...trader,
        rank: idx + 1,
      }))
      return {
        traders,
        window: 'COMPOSITE' as const,
        totalCount: traders.length,
        totalcount: traders.length,
        total_count: traders.length,
        eligible_count: scopedTraders.length,
        as_of: scopedFreshness.asOf,
        is_stale: scopedFreshness.isStale,
        source_freshness: scopedFreshness.sources,
        availableSources: [...scopedSources].sort(),
        next_cursor: null,
        precomputed: true,
      }
    }

    // Close the race across all three seasons after every database read and
    // before the first public cache write. A cutover preserves the last-good
    // composite instead of publishing a mixed-generation result.
    await publicationFence.verifyStillCurrent()

    const writeComposite = async (scope: string, value: ReturnType<typeof buildCompositeData>) => {
      const written = await tieredSet(
        publicRankingCacheKey(`precomputed:composite:${scope}:${COMPOSITE_CACHE_VERSION}`),
        createSealedCompositeCacheEntry(value, publicationFence.publications),
        'hot',
        ['rankings', 'composite'],
        {
          redisTtlSeconds: CACHE_TTL_SECONDS,
          staleWhileRevalidateSeconds: CACHE_STALE_WHILE_REVALIDATE_SECONDS,
        }
      )
      if (!written) throw new Error(`Failed to persist sealed composite cache for ${scope}`)
    }

    const compositeData = buildCompositeData(allTraders, authoritySources)
    await writeComposite('all', compositeData)

    // Also store per-category composites for faster filtered queries
    const categories = ['futures', 'spot', 'onchain'] as const
    for (const cat of categories) {
      const catTraders = allTraders.filter((trader) => trader.category === cat)
      const catSources = authoritySources.filter((source) => compositeCategory(source) === cat)
      await writeComposite(cat, buildCompositeData(catTraders, catSources))
    }

    // Platform filters are first-class UI controls. Precompute each dynamic
    // authority scope, including empty scopes, so an old platform cache can
    // never survive after the source stops publishing.
    for (const source of authoritySources) {
      const sourceTraders = allTraders.filter((trader) => trader.platform === source)
      await writeComposite(`platform:${source}`, buildCompositeData(sourceTraders, [source]))
    }

    const elapsed = Date.now() - startTime
    logger.info(
      `Composite precomputed: ${entries.length} total, ${compositeData.traders.length} cached, ${elapsed}ms`
    )

    clearTimeout(safetyTimer)
    if (!plogFinalized) {
      plogFinalized = true
      await plog.success(compositeData.traders.length, {
        total_entries: entries.length,
        elapsed_ms: elapsed,
      })
    }

    return NextResponse.json({
      ok: true,
      elapsed_ms: elapsed,
      total_entries: entries.length,
      cached_entries: compositeData.traders.length,
      categories_cached: categories.length,
      platforms_cached: authoritySources.length,
    })
  } catch (error) {
    clearTimeout(safetyTimer)
    logger.error('Precompute composite failed:', error)
    if (!plogFinalized) {
      plogFinalized = true
      await plog.error(error)
    }
    return NextResponse.json({ error: 'Precompute failed', detail: String(error) }, { status: 500 })
  } finally {
    await releaseLock()
  }
}
