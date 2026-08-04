/**
 * GET /api/v2/rankings
 *
 * Unified leaderboard endpoint.
 * Reads ONLY from database - no external fetching.
 *
 * Query params:
 *   window: '7d' | '30d' | '90d' (required)
 *   platform: string (required)
 *   market_type: 'futures' | 'spot' | 'perp' | 'web3' | 'copy' (optional filter)
 *   limit: number (default: 100, max: 500)
 *   offset: number (default: 0)
 *   sort: 'arena_score' | 'arena_score_v3' | 'roi' | 'pnl' | 'sortino' | 'calmar' (default: 'arena_score')
 *   trading_style: 'scalper' | 'swing' | 'trend' | 'position' (optional filter, legacy names also accepted)
 *   min_sortino: number (optional minimum sortino threshold)
 *   min_roi: number (optional minimum ROI %)
 *   min_pnl: number (optional minimum PnL $)
 *   min_win_rate: number (optional minimum win rate %)
 *   max_drawdown: number (optional maximum drawdown %)
 *   min_score: number (optional minimum arena score)
 *
 * Response includes:
 *   - traders: RankingEntry[]
 *   - meta: { platform, market_type, window, total_count, total_count_is_estimate,
 *             updated_at, staleness_seconds }
 *
 * Alpha has no persisted authority in leaderboard_ranks. `sort=alpha` and
 * every `min_alpha` request are rejected instead of silently substituting a
 * different metric.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Database } from '@/lib/supabase/database.types'
import type {
  Window,
  LeaderboardPlatform,
  MarketType,
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
import { getOrSetWithLock } from '@/lib/cache'
import { summarizeSourceFreshness, type SourceFreshnessRow } from '@/lib/rankings/source-freshness'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  isPublicRankingSourceQuarantined,
  publicRankingCacheKey,
  publicRankingCountFromCache,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import type { LeaderboardCountCacheRow } from '@/lib/data/leaderboard-count-cache'

// Publication actively invalidates the Redis generation; the route itself must
// not create a separate CDN/ISR generation that the publisher cannot purge.
export const dynamic = 'force-dynamic'
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'

type LeaderboardRankTableRow = Database['public']['Tables']['leaderboard_ranks']['Row']
const LEADERBOARD_RANK_SELECT_COLUMNS = [
  'source',
  'source_trader_id',
  'handle',
  'avatar_url',
  'source_type',
  'roi',
  'pnl',
  'win_rate',
  'max_drawdown',
  'trades_count',
  'followers',
  'arena_score',
  'arena_score_v3',
  'rank',
  'computed_at',
  'sharpe_ratio',
  'sortino_ratio',
  'calmar_ratio',
  'trading_style',
  'avg_holding_hours',
] as const satisfies readonly (keyof LeaderboardRankTableRow)[]
type LeaderboardRankSelectRow = Pick<
  LeaderboardRankTableRow,
  (typeof LEADERBOARD_RANK_SELECT_COLUMNS)[number]
>

// Building the selector from generated-schema keys keeps the result boundary exact without
// asking PostgREST's recursive literal parser to expand the entire query on every clean build.
const LEADERBOARD_RANK_SELECT: string = LEADERBOARD_RANK_SELECT_COLUMNS.join(',')

// ── Input validation schema ──────────────────────────────────────────────────
const v2RankingsSchema = z.object({
  window: z.enum(WINDOWS),
  platform: z.custom<TraderSource>(
    (value) => parsePublicActiveRankingSource(value) !== null,
    'Invalid platform'
  ),
  market_type: z.enum(MARKET_TYPES).optional(),
  limit: z.coerce.number().int().min(1).max(500).catch(100),
  offset: z.coerce.number().int().min(0).catch(0),
  sort: z
    .enum(['arena_score', 'arena_score_v3', 'roi', 'pnl', 'sortino', 'calmar'])
    .default('arena_score'),
  trading_style: z.string().optional(),
  min_sortino: z.coerce.number().optional(),
  min_roi: z.coerce.number().optional(),
  min_pnl: z.coerce.number().optional(),
  min_win_rate: z.coerce.number().optional(),
  max_drawdown: z.coerce.number().optional(),
  min_score: z.coerce.number().optional(),
})

export const GET = withPublic(
  async ({ supabase, request }) => {
    const { searchParams } = new URL(request.url)
    const rawParams = Object.fromEntries(searchParams)

    if (searchParams.get('sort') === 'alpha' || searchParams.has('min_alpha')) {
      return NextResponse.json(
        {
          error: 'Unsupported ranking metric',
          details: {
            alpha: ['Alpha has no authoritative leaderboard_ranks column'],
          },
        },
        { status: 400 }
      )
    }

    const parsed = v2RankingsSchema.safeParse(rawParams)

    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid parameters', details: parsed.error.flatten() },
        { status: 400 }
      )
    }

    const { window, platform: requestedPlatform, limit, offset, sort } = parsed.data

    const platform = requestedPlatform as LeaderboardPlatform
    const marketTypeFilter = parsed.data.market_type ?? null
    const marketType = (marketTypeFilter ||
      SOURCE_TYPE_MAP[String(platform)] ||
      'futures') as MarketType

    if (isPublicRankingSourceQuarantined(requestedPlatform)) {
      return NextResponse.json(
        {
          traders: [],
          meta: {
            platform: requestedPlatform,
            market_type: marketType,
            window,
            total_count: 0,
            total_count_is_estimate: false,
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
          headers: {
            'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL,
          },
        }
      )
    }

    const tradingStyle = parsed.data.trading_style || null
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

    const hasOptionalFilters =
      normalizedStyle !== null ||
      minSortino !== null ||
      minRoi !== null ||
      minPnl !== null ||
      minWinRate !== null ||
      maxDrawdown !== null ||
      minScore !== null
    const countIsEstimate = hasOptionalFilters || marketTypeFilter !== null

    // Redis cache — 120s TTL (data refreshes via cron every 30 min, 2-min cache is safe)
    const cacheKey = publicRankingCacheKey(
      [
        'v2-rankings:v4',
        `platform=${platform}`,
        `window=${window}`,
        `market_type_filter=${marketTypeFilter ?? ''}`,
        `sort=${sort}`,
        `offset=${offset}`,
        `limit=${limit}`,
        `trading_style=${normalizedStyle ?? ''}`,
        `min_sortino=${minSortino ?? ''}`,
        `min_roi=${minRoi ?? ''}`,
        `min_pnl=${minPnl ?? ''}`,
        `min_win_rate=${minWinRate ?? ''}`,
        `max_drawdown=${maxDrawdown ?? ''}`,
        `min_score=${minScore ?? ''}`,
      ].join(':')
    )

    const cached = await getOrSetWithLock<RankingsResponse>(
      cacheKey,
      async () => {
        // Database query — use leaderboard_ranks (precomputed, unified source of truth)
        // instead of trader_snapshots v1 which has stale/inconsistent data

        // Map window to season_id format used in leaderboard_ranks (uppercase)
        const seasonId = window.toUpperCase()

        const rankTable = supabase.from('leaderboard_ranks')
        // A planner count is always requested as the availability fallback. The
        // unfiltered cohort still prefers the generation-bound count cache, but
        // a missing auxiliary count generation must not take the ranked page down.
        let query = rankTable.select(LEADERBOARD_RANK_SELECT, { count: 'planned' })
        query = query.eq('source', platform).eq('season_id', seasonId)
        if (marketTypeFilter !== null) {
          query = query.eq('source_type', marketTypeFilter)
        }
        query = query
          .not('rank', 'is', null)
          .gt('arena_score', 0)
          .or('is_outlier.is.null,is_outlier.eq.false')

        if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
          query = query.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
        }

        // V3 Filters
        if (normalizedStyle) {
          query = query.eq('trading_style', normalizedStyle)
        }
        if (minSortino !== null) {
          query = query.gte('sortino_ratio', minSortino)
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

        switch (sort) {
          case 'roi':
            query = query.order('roi', { ascending: false, nullsFirst: false })
            break
          case 'pnl':
            query = query.order('pnl', { ascending: false, nullsFirst: false })
            break
          case 'sortino':
            query = query.order('sortino_ratio', { ascending: false, nullsFirst: false })
            break
          case 'calmar':
            query = query.order('calmar_ratio', { ascending: false, nullsFirst: false })
            break
          case 'arena_score_v3':
            query = query.order('arena_score_v3', { ascending: false, nullsFirst: false })
            break
          default:
            query = query.order('arena_score', { ascending: false, nullsFirst: false })
        }

        // Persisted rank is the final authority for every metric tie.
        query = query.order('rank', { ascending: true, nullsFirst: false })

        query = query.range(offset, offset + limit - 1)

        const countAuthorityQuery = countIsEstimate
          ? Promise.resolve({ data: null, error: null })
          : supabase
              .from('leaderboard_count_cache')
              .select('source,total_count,updated_at')
              .eq('season_id', seasonId)
              .like('source', '%_gt0')

        const [rankingResult, countAuthorityResult] = await Promise.all([
          query.overrideTypes<LeaderboardRankSelectRow[], { merge: false }>(),
          countAuthorityQuery,
        ])
        const { data: rows, count, error } = rankingResult

        if (error) {
          throw new Error('Database query failed')
        }

        const rankedRows = (rows || []).filter((row) => row.rank != null)
        const plannedCount =
          typeof count === 'number' && Number.isFinite(count) && count >= 0 ? count : 0
        const observedPageLowerBound = rankedRows.length > 0 ? offset + rankedRows.length : 0
        const estimatedTotalCount = Math.max(plannedCount, observedPageLowerBound)

        let totalCount: number
        let totalCountIsEstimate = countIsEstimate
        if (countIsEstimate) {
          totalCount = estimatedTotalCount
        } else {
          const { data: countRows, error: countError } = countAuthorityResult
          const authoritativeCount = countError
            ? null
            : publicRankingCountFromCache((countRows || []) as LeaderboardCountCacheRow[], {
                source: platform,
              })

          if (authoritativeCount === null) {
            totalCount = estimatedTotalCount
            totalCountIsEstimate = true
          } else {
            totalCount = authoritativeCount
          }
        }

        // leaderboard_ranks already has handle + avatar_url — no need for separate
        // trader_profiles / trader_sources joins (eliminated 2 extra DB queries)

        let freshnessQuery = supabase
          .from('leaderboard_source_freshness')
          .select('source,source_as_of')
          .eq('season_id', seasonId)
          .eq('source', platform)
        if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
          freshnessQuery = freshnessQuery.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
        }
        const { data: sourceWatermarkRows } = await freshnessQuery
        const freshnessSummary = summarizeSourceFreshness(
          (sourceWatermarkRows || []) as SourceFreshnessRow[],
          [platform]
        )

        // Build response — maintain exact same response format for frontend consumers
        const traders: RankingEntry[] = rankedRows.map((r) => {
          const sourceType = ((r.source_type as MarketType | null) || marketType) as MarketType
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
              sortino_ratio: r.sortino_ratio != null ? Number(r.sortino_ratio) : null,
              trades_count: r.trades_count != null ? Number(r.trades_count) : null,
              followers: r.followers != null ? Number(r.followers) : null,
              copiers: null as number | null,
              aum: null as number | null,
              platform_rank: Number(r.rank),
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
            arena_score_v3: r.arena_score_v3 != null ? Number(r.arena_score_v3) : null,
            sortino_ratio: r.sortino_ratio != null ? Number(r.sortino_ratio) : null,
            calmar_ratio: r.calmar_ratio != null ? Number(r.calmar_ratio) : null,
            alpha: null,
            trading_style: (r.trading_style as string) || null,
          } as RankingEntry & {
            arena_score_v3: number | null
            sortino_ratio: number | null
            calmar_ratio: number | null
            alpha: null
            trading_style: string | null
          }
        })

        return sanitizePublicRankingSourcePayload({
          traders,
          meta: {
            platform,
            market_type: marketType,
            window: window as Window,
            total_count: totalCount,
            total_count_is_estimate: totalCountIsEstimate,
            updated_at: freshnessSummary.asOf,
            staleness_seconds: freshnessSummary.ageSeconds,
            is_stale: freshnessSummary.isStale,
            source_freshness: freshnessSummary.sources,
          },
        }) as RankingsResponse
      }, // end fetcher
      {
        ttl: 120,
        tags: [PUBLIC_RANKING_REDIS_TAG, `season:${window.toUpperCase()}`],
        skipMemory: true,
        writeFenceKey: PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
      }
    ) // end getOrSetWithLock

    const safeCached = sanitizePublicRankingSourcePayload(cached)

    return NextResponse.json(safeCached, {
      headers: {
        'Cache-Control': PUBLIC_RANKING_RESPONSE_CACHE_CONTROL,
      },
    })
  },
  { name: 'v2-rankings' }
)
