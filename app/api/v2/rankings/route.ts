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
import type { Window, LeaderboardPlatform, RankingEntry, RankingsResponse } from '@/lib/types/leaderboard'
import { VALID_TRADING_STYLES, TRADING_STYLE_LEGACY_MAP, type TradingStyle } from '@/lib/types/trader'
import { LEADERBOARD_PLATFORMS, WINDOWS } from '@/lib/types/leaderboard'
import { SOURCE_TYPE_MAP } from '@/lib/constants/exchanges'
import { withPublic } from '@/lib/api/middleware'

export const dynamic = 'force-dynamic'
export const revalidate = 600  // ISR: revalidate every 10 minutes (data refreshes via cron every 30 min)

// ── Input validation schema ──────────────────────────────────────────────────
const v2RankingsSchema = z.object({
  window: z.enum(WINDOWS as unknown as [string, ...string[]]),
  platform: z.enum(LEADERBOARD_PLATFORMS as unknown as [string, ...string[]]),
  market_type: z.string().default('futures'),
  limit: z.coerce.number().int().min(1).max(500).catch(100),
  offset: z.coerce.number().int().min(0).catch(0),
  sort: z.enum(['arena_score', 'arena_score_v3', 'roi', 'pnl', 'sortino', 'calmar', 'alpha']).catch('arena_score'),
  trading_style: z.string().optional(),
  min_alpha: z.coerce.number().optional(),
  min_sortino: z.coerce.number().optional(),
  min_roi: z.coerce.number().optional(),
  min_pnl: z.coerce.number().optional(),
  min_win_rate: z.coerce.number().optional(),
  max_drawdown: z.coerce.number().optional(),
  min_score: z.coerce.number().optional(),
})

export const GET = withPublic(async ({ supabase, request }) => {
  const { searchParams } = new URL(request.url)
  const rawParams = Object.fromEntries(searchParams)
  const parsed = v2RankingsSchema.safeParse(rawParams)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { window, platform, market_type: marketType, limit, offset, sort } = parsed.data
  const tradingStyle = parsed.data.trading_style || null
  const _minAlpha = parsed.data.min_alpha ?? null
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
    ? (TRADING_STYLE_LEGACY_MAP[tradingStyle as keyof typeof TRADING_STYLE_LEGACY_MAP] || tradingStyle as TradingStyle)
    : null

  // Database query — use leaderboard_ranks (precomputed, unified source of truth)
  // instead of trader_snapshots v1 which has stale/inconsistent data

  // Map window to season_id format used in leaderboard_ranks (uppercase)
  const seasonId = window.toUpperCase()

  let query = supabase
    .from('leaderboard_ranks')
    .select(
      `source, source_trader_id, handle, avatar_url, source_type,
       roi, pnl, win_rate, max_drawdown, trades_count, followers,
       arena_score, rank, computed_at, season_id,
       sharpe_ratio,
       profitability_score, risk_control_score, execution_score, score_completeness,
       trading_style, avg_holding_hours, trader_type`,
      { count: 'exact' }
    )
    .eq('source', platform)
    .eq('season_id', seasonId)
    .not('arena_score', 'is', null)

  // V3 Filters
  if (normalizedStyle) {
    query = query.eq('trading_style', normalizedStyle)
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

  query = query.range(offset, offset + limit - 1)

  const { data: rows, count, error } = await query as {
    data: Record<string, unknown>[] | null
    count: number | null
    error: { message: string } | null
  }

  if (error) {
    return NextResponse.json(
      { error: 'Database query failed' },
      { status: 500 }
    )
  }

  // leaderboard_ranks already has handle + avatar_url — no need for separate
  // trader_profiles / trader_sources joins (eliminated 2 extra DB queries)

  // Calculate staleness
  const latestUpdate = rows && rows.length > 0
    ? new Date(Math.max(...rows.map(r => new Date(String(r.computed_at || '')).getTime()).filter(t => !isNaN(t))))
    : new Date(0)
  const stalenessSeconds = Math.floor((Date.now() - latestUpdate.getTime()) / 1000)

  // Build response — maintain exact same response format for frontend consumers
  const traders: RankingEntry[] = (rows || []).map(r => {
    const sourceType = (r.source_type as string) || SOURCE_TYPE_MAP[String(r.source)] || marketType
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
      quality_flags: { missing_fields: [] as string[], non_standard_fields: {} as Record<string, string>, window_native: true, notes: [] as string[] },
      updated_at: String(r.computed_at || ''),
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

  const response: RankingsResponse = {
    traders,
    meta: {
      platform: platform as LeaderboardPlatform,
      market_type: marketType as 'futures',
      window: window as Window,
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
}, { name: 'v2-rankings' })
