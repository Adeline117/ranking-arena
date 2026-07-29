/**
 * GET /api/v2/rankings
 *
 * Unified leaderboard endpoint.
 * Reads ONLY from database - no external fetching.
 *
 * Query params:
 *   window: '7d' | '30d' | '90d' (required)
 *   platform: string (required)
 *   market_type: string (default: 'futures')
 *   limit: number (default: 100, max: 500)
 *   offset: number (default: 0)
 *   sort: 'arena_score' | 'arena_score_v3' | 'roi' | 'pnl' | 'sortino' | 'calmar' | 'alpha' (default: 'arena_score')
 *   trading_style: 'scalper' | 'swing' | 'trend' | 'position' (optional filter, legacy names also accepted)
 *   min_alpha: number (optional minimum alpha threshold)
 *   min_sortino: number (optional minimum sortino threshold)
 *   min_roi: number (optional minimum ROI %)
 *   min_pnl: number (optional minimum PnL $)
 *   min_win_rate: number (optional minimum win rate %)
 *   max_drawdown: number (optional maximum drawdown %)
 *   min_score: number (optional minimum arena score)
 *
 * Response includes:
 *   - traders: RankingEntry[]
 *   - meta: { platform, market_type, window, total_count, updated_at, staleness_seconds }
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type {
  Window,
  LeaderboardPlatform,
  RankingEntry,
  RankingsResponse,
} from '@/lib/types/leaderboard'
import {
  VALID_TRADING_STYLES,
  TRADING_STYLE_LEGACY_MAP,
  type TradingStyle,
} from '@/lib/utils/trading-style'
import { MARKET_TYPES, WINDOWS } from '@/lib/types/leaderboard'
import {
  SOURCE_TYPE_MAP,
  parsePublicActiveRankingSource,
  type TraderSource,
} from '@/lib/constants/exchanges'
import { withPublic } from '@/lib/api/middleware'
import { del, getOrSetWithLock } from '@/lib/cache'
import { summarizeSourceFreshness, type SourceFreshnessRow } from '@/lib/rankings/source-freshness'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  isPublicRankingSourceQuarantined,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import type {
  LeaderboardPublicationSeason,
  SealedLeaderboardPublicationProofSet,
} from '@/lib/rankings/read-publication-proofs'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

// The Redis envelope remains the performance cache. HTTP responses cannot be
// shared because every request must prove that envelope against live authority.
export const dynamic = 'force-dynamic'
export const revalidate = 0

const RANKING_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

// ── Input validation schema ──────────────────────────────────────────────────
const v2RankingsSchema = z.object({
  window: z.enum(WINDOWS),
  platform: z.custom<TraderSource>(
    (value) => parsePublicActiveRankingSource(value) !== null,
    'Invalid platform'
  ),
  market_type: z.enum(MARKET_TYPES).default('futures'),
  limit: z.coerce.number().int().min(1).max(500).catch(100),
  offset: z.coerce.number().int().min(0).catch(0),
  sort: z
    .enum(['arena_score', 'arena_score_v3', 'roi', 'pnl', 'sortino', 'calmar', 'alpha'])
    .catch('arena_score'),
  trading_style: z.string().optional(),
  min_alpha: z.coerce.number().optional(),
  min_sortino: z.coerce.number().optional(),
  min_roi: z.coerce.number().optional(),
  min_pnl: z.coerce.number().optional(),
  min_win_rate: z.coerce.number().optional(),
  max_drawdown: z.coerce.number().optional(),
  min_score: z.coerce.number().optional(),
})

export const GET = withPublic(
  async ({ request }) => {
    const { searchParams } = new URL(request.url)
    const rawParams = Object.fromEntries(searchParams)
    const parsed = v2RankingsSchema.safeParse(rawParams)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid parameters', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const {
      window,
      platform: requestedPlatform,
      market_type: marketType,
      limit,
      offset,
      sort,
    } = parsed.data

    if (isPublicRankingSourceQuarantined(requestedPlatform)) {
      return NextResponse.json(
        {
          traders: [],
          meta: {
            platform: requestedPlatform,
            market_type: marketType,
            window,
            total_count: 0,
            updated_at: null,
            staleness_seconds: null,
            is_stale: true,
            source_freshness: [],
          },
          ranking_visibility: 'partial',
          ranking_visibility_reason: 'publication_policy_filtered',
          ranking_visibility_reasons: ['quarantined_source_requested'],
        },
        {
          headers: RANKING_NO_STORE_HEADERS,
        }
      )
    }

    const platform = requestedPlatform as LeaderboardPlatform
    const tradingStyle = parsed.data.trading_style || null
    const minAlpha = parsed.data.min_alpha ?? null
    const minSortino = parsed.data.min_sortino ?? null
    const minRoi = parsed.data.min_roi ?? null
    const minPnl = parsed.data.min_pnl ?? null
    const minWinRate = parsed.data.min_win_rate ?? null
    const maxDrawdown = parsed.data.max_drawdown ?? null
    const minScore = parsed.data.min_score ?? null

    // Validate trading_style against known values (accept both current and legacy names)
    const allValidStyles = [...VALID_TRADING_STYLES, ...Object.keys(TRADING_STYLE_LEGACY_MAP)]
    if (tradingStyle && !allValidStyles.includes(tradingStyle)) {
      return NextResponse.json(
        { error: `Invalid trading_style. Must be one of: ${VALID_TRADING_STYLES.join(', ')}` },
        { status: 400 }
      )
    }
    // Normalize legacy style names to current names
    const normalizedStyle = tradingStyle
      ? TRADING_STYLE_LEGACY_MAP[tradingStyle as keyof typeof TRADING_STYLE_LEGACY_MAP] ||
        (tradingStyle as TradingStyle)
      : null

    const seasonId = window.toUpperCase() as LeaderboardPublicationSeason
    const hasResultFilters =
      normalizedStyle !== null ||
      minAlpha !== null ||
      minSortino !== null ||
      minRoi !== null ||
      minPnl !== null ||
      minWinRate !== null ||
      maxDrawdown !== null ||
      minScore !== null

    // Redis cache — only proof-sealed envelopes are accepted. Every
    // response-shaping request parameter participates in the key.
    const cacheKey = publicRankingCacheKey(
      `v2-rankings:sealed-v4:${platform}:${window}:${marketType}:${sort}:${offset}:${limit}:${tradingStyle || ''}:${minAlpha ?? ''}:${minRoi ?? ''}:${minPnl ?? ''}:${minWinRate ?? ''}:${maxDrawdown ?? ''}:${minScore ?? ''}:${minSortino ?? ''}`
    )

    const supabase = getReadReplica()
    const fetchSealedEntry = async () => {
      const sealedRead = await readSealedRankingGeneration(
        supabase,
        { season: seasonId, sources: [platform] },
        async (publication) => {
          // Database query — use leaderboard_ranks (precomputed, unified source of truth)
          // instead of trader_snapshots v1 which has stale/inconsistent data

          let query = supabase
            .from('leaderboard_ranks')
            .select(
              `source, source_trader_id, handle, avatar_url, source_type,
       roi, pnl, win_rate, max_drawdown, trades_count, followers,
       arena_score, rank, computed_at, season_id,
       sharpe_ratio,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, trader_type`,
              hasResultFilters ? { count: 'exact' } : undefined
            )
            .eq('source', platform)
            .eq('season_id', seasonId)
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .in(
              'source',
              publication.proofs.map((proof) => proof.source)
            )
            .not('arena_score', 'is', null)
            .or('is_outlier.is.null,is_outlier.eq.false')

          if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
            query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
          }

          // V3 Filters
          if (normalizedStyle) {
            query = query.eq('trading_style', normalizedStyle)
          }
          if (minAlpha !== null) {
            // The legacy v2 contract documents alpha although the canonical table
            // only stores arena_score. Keep the documented proxy, but do not
            // silently ignore the filter.
            query = query.gte('arena_score', minAlpha)
          }
          if (minSortino !== null) {
            query = query.gte('sharpe_ratio', minSortino) // sortino not in leaderboard_ranks, use sharpe as proxy
          }
          if (minRoi !== null) {
            query = query.gte('roi', minRoi)
          }
          if (minPnl !== null) {
            query = query.gte('pnl', minPnl)
          }
          if (minWinRate !== null) {
            query = query.gte('win_rate', minWinRate)
          }
          if (maxDrawdown !== null) {
            query = query.lte('max_drawdown', maxDrawdown)
          }
          if (minScore !== null) {
            query = query.gte('arena_score', minScore)
          }

          // Sort — leaderboard_ranks doesn't have alpha/arena_score_v3 columns,
          // fall back to arena_score for those sorts
          switch (sort) {
            case 'roi':
              query = query.order('roi', { ascending: false, nullsFirst: false })
              break
            case 'pnl':
              query = query.order('pnl', { ascending: false, nullsFirst: false })
              break
            case 'sortino':
              query = query.order('sharpe_ratio', { ascending: false, nullsFirst: false }) // sortino not in leaderboard_ranks
              break
            case 'calmar':
              query = query.order('arena_score', { ascending: false, nullsFirst: false }) // calmar not in leaderboard_ranks
              break
            case 'arena_score_v3':
            case 'alpha':
            default:
              query = query.order('arena_score', { ascending: false, nullsFirst: false })
          }

          query = query
            .order('source_trader_id', { ascending: true })
            .range(offset, offset + limit - 1)

          const {
            data: rows,
            count,
            error,
          } = (await query) as {
            data: Record<string, unknown>[] | null
            count: number | null
            error: { message: string } | null
          }

          if (error) {
            throw new Error(`Database query failed: ${error.message}`)
          }
          if (rows === null) {
            throw new Error('Database query returned no row payload')
          }
          if (hasResultFilters && (!Number.isSafeInteger(count) || (count as number) < 0)) {
            throw new Error('Filtered database query returned no exact count')
          }

          // Watermark, membership and row count come from the exact proof set
          // that authorized this cohort, never from mutable aggregate tables.
          const freshnessSummary = summarizePublicationFreshness(publication, platform)

          // Build response — maintain exact same response format for frontend consumers
          const traders: RankingEntry[] = rows.map((r) => {
            const sourceType =
              (r.source_type as string) || SOURCE_TYPE_MAP[String(r.source)] || marketType
            const baseEntry = {
              platform: r.source as LeaderboardPlatform,
              market_type: sourceType,
              trader_key: String(r.source_trader_id),
              display_name: (r.handle as string) || null,
              avatar_url: (r.avatar_url as string) || null,
              window: window as Window,
              metrics: {
                roi: r.roi != null ? Number(r.roi) : null,
                pnl: r.pnl != null ? Number(r.pnl) : null,
                win_rate: r.win_rate != null ? Number(r.win_rate) : null,
                max_drawdown: r.max_drawdown != null ? Number(r.max_drawdown) : null,
                sharpe_ratio: r.sharpe_ratio != null ? Number(r.sharpe_ratio) : null,
                sortino_ratio: null, // not in leaderboard_ranks
                trades_count: r.trades_count != null ? Number(r.trades_count) : null,
                followers: r.followers != null ? Number(r.followers) : null,
                copiers: null as number | null,
                aum: null as number | null,
                platform_rank: r.rank != null ? Number(r.rank) : null,
                arena_score: r.arena_score != null ? Number(r.arena_score) : null,
                return_score: null as number | null,
                drawdown_score: null as number | null,
                stability_score: null as number | null,
                volatility_pct: null as number | null,
                avg_holding_hours: r.avg_holding_hours != null ? Number(r.avg_holding_hours) : null,
                profit_factor: null, // not in leaderboard_ranks
              },
              quality_flags: {
                missing_fields: [] as string[],
                non_standard_fields: {} as Record<string, string>,
                window_native: true,
                notes: [] as string[],
              },
              updated_at: freshnessSummary.asOf,
              is_stale: freshnessSummary.isStale,
              computed_at: String(r.computed_at || '') || null,
            }

            return {
              ...baseEntry,
              // V3 extended fields
              arena_score_v3: null,
              sortino_ratio: null, // not in leaderboard_ranks
              calmar_ratio: null, // not in leaderboard_ranks
              alpha: null,
              trading_style: (r.trading_style as string) || null,
            } as RankingEntry & {
              arena_score_v3: number | null
              sortino_ratio: number | null
              calmar_ratio: number | null
              alpha: number | null
              trading_style: string | null
            }
          })

          return sanitizePublicRankingSourcePayload({
            traders,
            meta: {
              platform,
              market_type: marketType as RankingsResponse['meta']['market_type'],
              window: window as Window,
              total_count: hasResultFilters
                ? (count as number)
                : publication.proofs[0].published_rank_count,
              updated_at: freshnessSummary.asOf,
              staleness_seconds: freshnessSummary.ageSeconds,
              is_stale: freshnessSummary.isStale,
              source_freshness: freshnessSummary.sources,
            },
          }) as RankingsResponse
        },
        { timeoutMs: 10_000 }
      )
      return createSealedRankingCacheEntry(sealedRead)
    }

    const readAuthorizedCache = async () => {
      const cached = await getOrSetWithLock<unknown>(cacheKey, fetchSealedEntry, { ttl: 120 })
      const sealedCache = parseSealedRankingCacheEntry<RankingsResponse>(cached, seasonId, [
        platform,
      ])
      if (!sealedCache) return null

      const currentGeneration = await readSealedRankingGeneration(
        supabase,
        { season: seasonId, sources: [platform] },
        async () => null,
        { timeoutMs: 10_000 }
      )
      return currentGeneration.publicationIdentity === sealedCache.publicationIdentity
        ? sealedCache
        : null
    }

    let sealedCache = await readAuthorizedCache()
    if (!sealedCache) {
      await del(cacheKey)
      sealedCache = await readAuthorizedCache()
    }
    if (!sealedCache) {
      throw new Error('Ranking cache did not satisfy the sealed publication contract')
    }

    return NextResponse.json(sanitizePublicRankingSourcePayload(sealedCache.value), {
      headers: RANKING_NO_STORE_HEADERS,
    })
  },
  { name: 'v2-rankings' }
)

function summarizePublicationFreshness(
  publication: SealedLeaderboardPublicationProofSet,
  platform: LeaderboardPlatform
) {
  return summarizeSourceFreshness(
    publication.proofs.map(
      (proof): SourceFreshnessRow => ({
        source: proof.source,
        source_as_of: proof.source_as_of,
      })
    ),
    [platform]
  )
}
