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
 *   trading_style: 'hft' | 'day_trader' | 'swing' | 'trend' | 'scalping' (optional filter)
 *   min_alpha: number (optional minimum alpha threshold)
 *   min_sortino: number (optional minimum sortino threshold)
 *
 * Response includes:
 *   - traders: RankingEntry[]
 *   - meta: { platform, market_type, window, total_count, updated_at, staleness_seconds }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { Window, LeaderboardPlatform, RankingEntry, RankingsResponse } from '@/lib/types/leaderboard'
import { LEADERBOARD_PLATFORMS, WINDOWS } from '@/lib/types/leaderboard'
import logger from '@/lib/logger'

export const dynamic = 'force-dynamic'
export const revalidate = 60  // ISR: revalidate every 60 seconds

export async function GET(request: NextRequest) {
  try {
  const { searchParams } = new URL(request.url)

  // Parse and validate params
  const window = searchParams.get('window') as Window
  const platform = searchParams.get('platform') as LeaderboardPlatform
  const marketType = searchParams.get('market_type') || 'futures'
  const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 500)
  const offset = parseInt(searchParams.get('offset') || '0', 10)
  const sort = searchParams.get('sort') || 'arena_score'

  // V3 filters
  const tradingStyle = searchParams.get('trading_style')
  const minAlpha = searchParams.get('min_alpha') ? parseFloat(searchParams.get('min_alpha')!) : null
  const minSortino = searchParams.get('min_sortino') ? parseFloat(searchParams.get('min_sortino')!) : null

  // Validation
  if (!window || !WINDOWS.includes(window)) {
    return NextResponse.json(
      { error: 'Invalid or missing window parameter. Must be: 7d, 30d, or 90d' },
      { status: 400 }
    )
  }

  if (!platform || !LEADERBOARD_PLATFORMS.includes(platform)) {
    return NextResponse.json(
      { error: `Invalid platform. Must be one of: ${LEADERBOARD_PLATFORMS.join(', ')}` },
      { status: 400 }
    )
  }

  const validSorts = ['arena_score', 'arena_score_v3', 'roi', 'pnl', 'sortino', 'calmar', 'alpha']
  if (!validSorts.includes(sort)) {
    return NextResponse.json(
      { error: `Invalid sort. Must be one of: ${validSorts.join(', ')}` },
      { status: 400 }
    )
  }

  const validStyles = ['hft', 'day_trader', 'swing', 'trend', 'scalping']
  if (tradingStyle && !validStyles.includes(tradingStyle)) {
    return NextResponse.json(
      { error: `Invalid trading_style. Must be one of: ${validStyles.join(', ')}` },
      { status: 400 }
    )
  }

  // Database query
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  const supabase = createClient(supabaseUrl, supabaseAnonKey)

  // Build query for latest snapshots per trader for this window
  let query = supabase
    .from('trader_snapshots')
    .select('id, source, source_trader_id, season_id, captured_at, arena_score, arena_score_v3, roi, pnl, max_drawdown, win_rate, trades_count, followers, rank, sortino_ratio, calmar_ratio, profit_factor, alpha, volatility_pct, avg_holding_hours, trading_style, profitability_score, risk_control_score, execution_score, score_completeness, aum, sharpe_ratio', { count: 'exact' })
    .eq('source', platform)
    .eq('market_type', marketType)
    .eq('window', window)
    .not('arena_score', 'is', null)

  // V3 Filters
  if (tradingStyle) {
    query = query.eq('trading_style', tradingStyle)
  }
  if (minAlpha !== null) {
    query = query.gte('alpha', minAlpha)
  }
  if (minSortino !== null) {
    query = query.gte('sortino_ratio', minSortino)
  }

  // Sort
  switch (sort) {
    case 'roi':
      query = query.order('roi', { ascending: false, nullsFirst: false })
      break
    case 'pnl':
      query = query.order('pnl', { ascending: false, nullsFirst: false })
      break
    case 'arena_score_v3':
      query = query.order('arena_score_v3', { ascending: false, nullsFirst: false })
      break
    case 'sortino':
      query = query.order('sortino_ratio', { ascending: false, nullsFirst: false })
      break
    case 'calmar':
      query = query.order('calmar_ratio', { ascending: false, nullsFirst: false })
      break
    case 'alpha':
      query = query.order('alpha', { ascending: false, nullsFirst: false })
      break
    default:
      query = query.order('arena_score', { ascending: false, nullsFirst: false })
  }

  query = query.range(offset, offset + limit - 1)

   
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: snapshots, count, error } = await query as { data: Record<string, any>[] | null; count: number | null; error: { message: string } | null }

  if (error) {
    logger.error('[Rankings API] Query error:', error)
    return NextResponse.json(
      { error: 'Database query failed' },
      { status: 500 }
    )
  }

  // Join with profiles for display_name and avatar
  const traderKeys = (snapshots || []).map(s => s.source_trader_id)

  let profiles: Record<string, { display_name: string | null; avatar_url: string | null }> = {}
  if (traderKeys.length > 0) {
    const { data: profileData } = await supabase
      .from('trader_profiles')
      .select('trader_key, display_name, avatar_url')
      .eq('platform', platform)
      .eq('market_type', marketType)
      .in('trader_key', traderKeys)

    if (profileData) {
      profiles = Object.fromEntries(
        profileData.map(p => [p.trader_key, { display_name: p.display_name, avatar_url: p.avatar_url }])
      )
    }
  }

  // Also check trader_sources for handle/display_name fallback
  if (traderKeys.length > 0) {
    const { data: sourceData } = await supabase
      .from('trader_sources')
      .select('source_trader_id, handle, display_name')
      .eq('source', platform)
      .eq('market_type', marketType)
      .in('source_trader_id', traderKeys)

    if (sourceData) {
      for (const s of sourceData) {
        if (!profiles[s.source_trader_id]) {
          profiles[s.source_trader_id] = {
            display_name: s.display_name || s.handle,
            avatar_url: null,
          }
        }
      }
    }
  }

  // Calculate staleness
  const latestUpdate = snapshots && snapshots.length > 0
    ? new Date(Math.max(...snapshots.map(s => new Date(s.captured_at || s.created_at).getTime())))
    : new Date(0)
  const stalenessSeconds = Math.floor((Date.now() - latestUpdate.getTime()) / 1000)

  // Build response
  const traders: RankingEntry[] = (snapshots || []).map(s => {
    const baseEntry = {
      platform: s.source as LeaderboardPlatform,
      market_type: s.market_type,
      trader_key: s.source_trader_id,
      display_name: profiles[s.source_trader_id]?.display_name || null,
      avatar_url: profiles[s.source_trader_id]?.avatar_url || null,
      window: s.window as Window,
      metrics: s.metrics || {
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
        arena_score: s.arena_score ? parseFloat(s.arena_score) : null,
        return_score: s.return_score ? parseFloat(s.return_score) : null,
        drawdown_score: s.drawdown_score ? parseFloat(s.drawdown_score) : null,
        stability_score: s.stability_score ? parseFloat(s.stability_score) : null,
        // V3 metrics
        volatility_pct: s.volatility_pct ? parseFloat(s.volatility_pct) : null,
        avg_holding_hours: s.avg_holding_hours ? parseFloat(s.avg_holding_hours) : null,
        profit_factor: s.profit_factor ? parseFloat(s.profit_factor) : null,
      },
      quality_flags: s.quality_flags || { missing_fields: [], non_standard_fields: {}, window_native: true, notes: [] },
      updated_at: s.captured_at || s.created_at,
    }

    // Add V3 extended fields (optional - only if available)
    return {
      ...baseEntry,
      // V3 Arena Score
      arena_score_v3: s.arena_score_v3 ? parseFloat(s.arena_score_v3) : null,
      // Advanced metrics summary
      sortino_ratio: s.sortino_ratio ? parseFloat(s.sortino_ratio) : null,
      calmar_ratio: s.calmar_ratio ? parseFloat(s.calmar_ratio) : null,
      alpha: s.alpha ? parseFloat(s.alpha) : null,
      // Classification
      trading_style: s.trading_style || null,
    } as RankingEntry & {
      arena_score_v3: number | null
      sortino_ratio: number | null
      calmar_ratio: number | null
      alpha: number | null
      trading_style: string | null
    }
  })

  // Filter out traders with no display name (NULL handles)
  const filteredTraders = traders.filter((t) => t.display_name != null);

  const response: RankingsResponse = {
    traders: filteredTraders,
    meta: {
      platform,
      market_type: marketType as 'futures',
      window,
      total_count: count || 0,
      updated_at: latestUpdate.toISOString(),
      staleness_seconds: stalenessSeconds,
    },
  }

  return NextResponse.json(response, {
    headers: {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
    },
  })
  } catch (error) {
    logger.error('[v2-rankings] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
