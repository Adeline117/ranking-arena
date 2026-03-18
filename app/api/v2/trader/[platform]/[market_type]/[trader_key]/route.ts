/**
 * GET /api/v2/trader/:platform/:market_type/:trader_key
 *
 * Trader detail endpoint.
 * Uses unified data layer for profile + snapshot data.
 * Target: <200ms response time.
 *
 * Response includes:
 *   - profile: TraderProfile
 *   - snapshots: { '7d': Snapshot | null, '30d': ..., '90d': ... }
 *   - timeseries: TraderTimeseries[]
 *   - refresh_status: { last_refreshed_at, is_refreshing, next_refresh_at }
 *   - provenance: DataProvenance
 */

import { NextRequest } from 'next/server'
import type {
  Window,
  LeaderboardPlatform,
  MarketType,
  TraderDetailResponse,
  TraderSnapshot,
  TraderTimeseries,
  TraderProfile,
  SnapshotMetrics,
  QualityFlags,
} from '@/lib/types/leaderboard'
import { ApiError } from '@/lib/api/errors'
import { success as apiSuccess, withCache } from '@/lib/api/response'
import { getTraderDetail } from '@/lib/data/unified'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { withPublic } from '@/lib/api/middleware'

export const dynamic = 'force-dynamic'

interface RouteParams {
  params: Promise<{
    platform: string
    market_type: string
    trader_key: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const { platform, market_type, trader_key } = await params

  const handler = withPublic(async ({ supabase }) => {
  // Fetch unified trader detail + timeseries + refresh jobs in parallel
  const [unifiedDetail, timeseriesResult, jobsResult] = await Promise.all([
    // 1. Unified data layer: profile + snapshots + enrichment
    getTraderDetail(supabase, { platform, traderKey: trader_key }),

    // 2. Timeseries (not in unified layer — kept as direct query)
    supabase
      .from('trader_timeseries')
      .select('platform, market_type, trader_key, series_type, as_of_ts, data, updated_at')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key)
      .order('timestamp', { ascending: false })
      .limit(500),

    // 3. Refresh status (not in unified layer — kept as direct query)
    supabase
      .from('refresh_jobs')
      .select('status, created_at, next_run_at')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key)
      .in('status', ['pending', 'running', 'completed'])
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  if (!unifiedDetail) {
    throw ApiError.notFound('Trader not found')
  }

  const t = unifiedDetail.trader

  // Build profile from unified trader data — maintain TraderProfile response format
  const profile: TraderProfile = {
    platform: platform as LeaderboardPlatform,
    market_type: market_type as MarketType,
    trader_key: trader_key,
    display_name: t.handle || trader_key,
    avatar_url: t.avatarUrl || null,
    bio: null,
    tags: [],
    profile_url: t.profileUrl || null,
    followers: t.followers ?? null,
    copiers: t.copiers ?? null,
    aum: null,
    updated_at: t.lastUpdated || new Date().toISOString(),
    last_enriched_at: null,
    provenance: {
      source_platform: platform,
      acquisition_method: 'scrape' as const,
      fetched_at: t.lastUpdated || new Date().toISOString(),
      source_url: t.profileUrl || null,
      scraper_version: null,
    },
  }

  // Build snapshots map from unified periods — reshape to TraderDetailResponse format
  const windowMap: Record<string, Window> = { '90D': '90d', '30D': '30d', '7D': '7d' }
  const snapshotsMap: Record<Window, TraderSnapshot | null> = {
    '7d': null,
    '30d': null,
    '90d': null,
  }

  for (const [periodKey, windowKey] of Object.entries(windowMap)) {
    const periodData = unifiedDetail.periods[periodKey as '7D' | '30D' | '90D']
    if (!periodData) continue

    const sourceType = (t.marketType as string) || SOURCE_TYPE_MAP[platform] || market_type

    const metrics: SnapshotMetrics = {
      roi: periodData.roi ?? null,
      pnl: periodData.pnl ?? null,
      win_rate: periodData.winRate ?? null,
      max_drawdown: periodData.maxDrawdown ?? null,
      sharpe_ratio: periodData.sharpeRatio ?? null,
      sortino_ratio: periodData.sortinoRatio ?? null,
      trades_count: periodData.tradesCount ?? null,
      followers: periodData.followers ?? null,
      copiers: periodData.copiers ?? null,
      aum: null,
      platform_rank: periodData.rank ?? null,
      arena_score: periodData.arenaScore ?? null,
      return_score: periodData.returnScore ?? null,
      drawdown_score: periodData.drawdownScore ?? null,
      stability_score: periodData.stabilityScore ?? null,
      volatility_pct: null,
      avg_holding_hours: periodData.avgHoldingHours ?? null,
      profit_factor: periodData.profitFactor ?? null,
    }

    const advancedMetrics = {
      sortino_ratio: periodData.sortinoRatio ?? null,
      calmar_ratio: periodData.calmarRatio ?? null,
      profit_factor: periodData.profitFactor ?? null,
      recovery_factor: null,
      max_consecutive_wins: null,
      max_consecutive_losses: null,
      avg_holding_hours: periodData.avgHoldingHours ?? null,
      volatility_pct: null,
      downside_volatility_pct: null,
    }

    const marketCorrelation = {
      beta_btc: null,
      beta_eth: null,
      alpha: null,
      market_condition_performance: { bull: null, bear: null, sideways: null },
    }

    const classification = {
      trading_style: periodData.tradingStyle ?? null,
      asset_preference: [] as string[],
      style_confidence: null,
    }

    const qualityFlags: QualityFlags = {
      missing_fields: [],
      non_standard_fields: {},
      window_native: true,
      notes: [],
    }

    snapshotsMap[windowKey] = {
      platform: platform as LeaderboardPlatform,
      market_type: sourceType as MarketType,
      trader_key: trader_key,
      window: windowKey,
      as_of_ts: periodData.lastUpdated || new Date().toISOString(),
      metrics,
      quality_flags: qualityFlags,
      updated_at: periodData.lastUpdated || new Date().toISOString(),
      advanced_metrics: advancedMetrics,
      market_correlation: marketCorrelation,
      classification,
      arena_score_v3: null,
    } as TraderSnapshot & {
      advanced_metrics: typeof advancedMetrics
      market_correlation: typeof marketCorrelation
      classification: typeof classification
      arena_score_v3: null
    }
  }

  // Build timeseries
  const timeseries: TraderTimeseries[] = (timeseriesResult.data || []).map(ts => ({
    platform: ts.platform as LeaderboardPlatform,
    market_type: ts.market_type as MarketType,
    trader_key: ts.trader_key,
    series_type: ts.series_type,
    as_of_ts: ts.as_of_ts,
    data: ts.data || [],
    updated_at: ts.updated_at,
  }))

  // Build refresh status
  const latestJob = jobsResult.data?.[0]
  const refreshStatus = {
    last_refreshed_at: latestJob?.status === 'completed' ? latestJob.created_at : null,
    is_refreshing: latestJob?.status === 'running' || latestJob?.status === 'pending',
    next_refresh_at: latestJob?.next_run_at || null,
  }

  const response: TraderDetailResponse = {
    profile,
    snapshots: snapshotsMap,
    timeseries,
    refresh_status: refreshStatus,
    provenance: profile.provenance || {
      source_platform: platform,
      acquisition_method: 'scrape' as const,
      fetched_at: new Date().toISOString(),
      source_url: null,
      scraper_version: null,
    },
  }

  const apiResponse = apiSuccess(response);
  return withCache(apiResponse, { maxAge: 30, staleWhileRevalidate: 120 });
  }, { name: 'v2-trader-detail' })

  return handler(request)
}
