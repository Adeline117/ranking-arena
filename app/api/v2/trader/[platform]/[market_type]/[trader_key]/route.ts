/**
 * GET /api/v2/trader/:platform/:market_type/:trader_key
 *
 * Trader detail endpoint.
 * Reads ONLY from database - no external fetching.
 * Target: <200ms response time.
 *
 * Response includes:
 *   - profile: TraderProfile
 *   - snapshots: { '7d': Snapshot | null, '30d': ..., '90d': ... }
 *   - timeseries: TraderTimeseries[]
 *   - refresh_status: { last_refreshed_at, is_refreshing, next_refresh_at }
 *   - provenance: DataProvenance
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
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
import { WINDOWS } from '@/lib/types/leaderboard'
import { logger } from '@/lib/logger'

export const dynamic = 'force-dynamic'

interface RouteParams {
  params: Promise<{
    platform: string
    market_type: string
    trader_key: string
  }>
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
  const { platform, market_type, trader_key } = await params

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  // Parallel queries for performance (<200ms target)
  const [profileResult, snapshotsResult, timeseriesResult, jobsResult] = await Promise.all([
    // 1. Profile
    supabase
      .from('trader_profiles')
      .select('*')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key)
      .single(),

    // 2. Latest snapshots for each window
    supabase
      .from('trader_snapshots')
      .select('*')
      .eq('source', platform)
      .eq('market_type', market_type)
      .eq('source_trader_id', trader_key)
      .in('window', ['7d', '30d', '90d'])
      .order('captured_at', { ascending: false })
      .limit(10),

    // 3. Timeseries
    supabase
      .from('trader_timeseries')
      .select('*')
      .eq('platform', platform)
      .eq('market_type', market_type)
      .eq('trader_key', trader_key),

    // 4. Refresh status
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

  // Build profile (fallback to trader_sources if no profile)
  let profile: TraderProfile
  if (profileResult.data) {
    profile = profileResult.data as unknown as TraderProfile
  } else {
    // Fallback: check trader_sources
    const { data: sourceData } = await supabase
      .from('trader_sources')
      .select('*')
      .eq('source', platform)
      .eq('market_type', market_type)
      .eq('source_trader_id', trader_key)
      .single()

    if (!sourceData) {
      return NextResponse.json(
        { error: 'Trader not found' },
        { status: 404 }
      )
    }

    profile = {
      platform: platform as LeaderboardPlatform,
      market_type: market_type as MarketType,
      trader_key: trader_key,
      display_name: sourceData.display_name || sourceData.handle || trader_key,
      avatar_url: null,
      bio: null,
      tags: [],
      profile_url: sourceData.profile_url,
      followers: null,
      copiers: null,
      aum: null,
      updated_at: sourceData.updated_at,
      last_enriched_at: null,
      provenance: {
        source_platform: platform,
        acquisition_method: 'scrape',
        fetched_at: sourceData.updated_at,
        source_url: sourceData.profile_url,
        scraper_version: null,
      },
    }
  }

  // Build snapshots map (latest per window)
  const snapshotsMap: Record<Window, TraderSnapshot | null> = {
    '7d': null,
    '30d': null,
    '90d': null,
  }

  if (snapshotsResult.data) {
    const seen = new Set<string>()
    for (const s of snapshotsResult.data) {
      const w = s.window as Window
      if (w && WINDOWS.includes(w) && !seen.has(w)) {
        seen.add(w)
        const metrics: SnapshotMetrics = s.metrics || {
          // Core metrics
          roi: s.roi ? parseFloat(s.roi) : null,
          pnl: s.pnl ? parseFloat(s.pnl) : null,
          win_rate: s.win_rate ? parseFloat(s.win_rate) : null,
          max_drawdown: s.max_drawdown ? parseFloat(s.max_drawdown) : null,
          sharpe_ratio: s.sharpe_ratio ? parseFloat(s.sharpe_ratio) : null,
          sortino_ratio: s.sortino_ratio ? parseFloat(s.sortino_ratio) : null,
          trades_count: s.trades_count,
          followers: s.followers,
          copiers: s.copiers,
          aum: s.aum ? parseFloat(s.aum) : null,
          platform_rank: s.platform_rank || s.rank,
          // Arena Score V2
          arena_score: s.arena_score ? parseFloat(s.arena_score) : null,
          return_score: s.return_score ? parseFloat(s.return_score) : null,
          drawdown_score: s.drawdown_score ? parseFloat(s.drawdown_score) : null,
          stability_score: s.stability_score ? parseFloat(s.stability_score) : null,
          // Extended metrics (V3)
          volatility_pct: s.volatility_pct ? parseFloat(s.volatility_pct) : null,
          avg_holding_hours: s.avg_holding_hours ? parseFloat(s.avg_holding_hours) : null,
          profit_factor: s.profit_factor ? parseFloat(s.profit_factor) : null,
        }

        // V3 Advanced metrics extension
        const advancedMetrics = {
          sortino_ratio: s.sortino_ratio ? parseFloat(s.sortino_ratio) : null,
          calmar_ratio: s.calmar_ratio ? parseFloat(s.calmar_ratio) : null,
          profit_factor: s.profit_factor ? parseFloat(s.profit_factor) : null,
          recovery_factor: s.recovery_factor ? parseFloat(s.recovery_factor) : null,
          max_consecutive_wins: s.max_consecutive_wins ?? null,
          max_consecutive_losses: s.max_consecutive_losses ?? null,
          avg_holding_hours: s.avg_holding_hours ? parseFloat(s.avg_holding_hours) : null,
          volatility_pct: s.volatility_pct ? parseFloat(s.volatility_pct) : null,
          downside_volatility_pct: s.downside_volatility_pct ? parseFloat(s.downside_volatility_pct) : null,
        }

        // Market correlation
        const marketCorrelation = {
          beta_btc: s.beta_btc ? parseFloat(s.beta_btc) : null,
          beta_eth: s.beta_eth ? parseFloat(s.beta_eth) : null,
          alpha: s.alpha ? parseFloat(s.alpha) : null,
          market_condition_performance: s.market_condition_tags || { bull: null, bear: null, sideways: null },
        }

        // Trader classification
        const classification = {
          trading_style: s.trading_style || null,
          asset_preference: s.asset_preference || [],
          style_confidence: s.style_confidence ? parseFloat(s.style_confidence) : null,
        }

        // Arena Score V3
        const arenaScoreV3 = s.arena_score_v3 ? {
          return_score: s.return_score ? parseFloat(s.return_score) : 0,
          pnl_score: s.pnl_score ? parseFloat(s.pnl_score) : 0,
          drawdown_score: s.drawdown_score ? parseFloat(s.drawdown_score) : 0,
          stability_score: s.stability_score ? parseFloat(s.stability_score) : 0,
          alpha_score: s.alpha_score ? parseFloat(s.alpha_score) : 0,
          risk_adjusted_score: s.risk_adjusted_score_v3 ? parseFloat(s.risk_adjusted_score_v3) : 0,
          consistency_score: s.consistency_score ? parseFloat(s.consistency_score) : 0,
          total_score: parseFloat(s.arena_score_v3),
        } : null

        const qualityFlags: QualityFlags = s.quality_flags || {
          missing_fields: [],
          non_standard_fields: {},
          window_native: true,
          notes: [],
        }

        snapshotsMap[w] = {
          platform: s.source as LeaderboardPlatform,
          market_type: s.market_type as MarketType,
          trader_key: s.source_trader_id,
          window: w,
          as_of_ts: s.as_of_ts || s.captured_at,
          metrics,
          quality_flags: qualityFlags,
          updated_at: s.captured_at || s.created_at,
          // V3 Extensions (attached to snapshot for per-window access)
          advanced_metrics: advancedMetrics,
          market_correlation: marketCorrelation,
          classification,
          arena_score_v3: arenaScoreV3,
        } as TraderSnapshot & {
          advanced_metrics: typeof advancedMetrics
          market_correlation: typeof marketCorrelation
          classification: typeof classification
          arena_score_v3: typeof arenaScoreV3
        }
      }
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

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120',
    },
  })
  } catch (error) {
    logger.error('[v2-trader-detail] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
