/**
 * Server-side data fetching for the PK comparison page.
 * Resolves trader handles to their metrics from Supabase.
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import type {
  PKTraderData,
  TraderSourceRow,
  LeaderboardRow,
  SnapshotRow,
} from './pk-types'

// ─── Helpers ─────────────────────────────────────────────────────────────────

function normalizeWinRate(wr: number | null | undefined): number | null {
  if (wr == null) return null
  return wr > 0 && wr <= 1 ? wr * 100 : wr
}

// ─── Main fetcher ────────────────────────────────────────────────────────────

export async function fetchPKTrader(
  handle: string,
  platform: string | null,
  timeWindow: string
): Promise<PKTraderData | null> {
  try {
    const supabase = getSupabaseAdmin()

    // 1. Resolve trader source
    let srcQuery = supabase
      .from('trader_sources')
      .select('handle, avatar_url, source, source_trader_id')
      .ilike('handle', handle)

    if (platform) {
      srcQuery = srcQuery.eq('source', platform)
    }

    const { data: src } = (await srcQuery
      .limit(1)
      .maybeSingle()) as { data: TraderSourceRow | null }

    if (!src) return null

    // 2. Fetch metrics depending on time window
    let metrics: {
      roi: number | null
      pnl: number | null
      win_rate: number | null
      max_drawdown: number | null
      arena_score: number | null
      rank: number | null
      trades_count: number | null
    }

    if (timeWindow === '7d' || timeWindow === '30d') {
      const seasonId = timeWindow === '7d' ? '7D' : '30D'

      const { data: snap } = (await supabase
        .from('trader_snapshots')
        .select(
          'roi, pnl, win_rate, max_drawdown, trades_count, arena_score'
        )
        .eq('source', src.source)
        .eq('source_trader_id', src.source_trader_id)
        .eq('season_id', seasonId)
        .order('captured_at', { ascending: false })
        .limit(1)
        .maybeSingle()) as { data: SnapshotRow | null }

      metrics = {
        roi: snap?.roi ?? null,
        pnl: snap?.pnl ?? null,
        win_rate: snap?.win_rate ?? null,
        max_drawdown: snap?.max_drawdown ?? null,
        arena_score: snap?.arena_score ?? null,
        rank: null,
        trades_count: snap?.trades_count ?? null,
      }
    } else {
      // Default (90d): parallel fetch leaderboard_ranks + trades_count
      const [lrResult, snapResult] = await Promise.all([
        supabase
          .from('leaderboard_ranks')
          .select(
            'display_name, rank, arena_score, roi, pnl, win_rate, max_drawdown'
          )
          .eq('source', src.source)
          .eq('source_trader_id', src.source_trader_id)
          .maybeSingle(),
        supabase
          .from('trader_snapshots')
          .select('trades_count')
          .eq('source', src.source)
          .eq('source_trader_id', src.source_trader_id)
          .not('season_id', 'in', '("7D","30D")')
          .order('captured_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

      const lr = lrResult.data as LeaderboardRow | null
      const snap = snapResult.data as { trades_count: number | null } | null

      metrics = {
        roi: lr?.roi ?? null,
        pnl: lr?.pnl ?? null,
        win_rate: lr?.win_rate ?? null,
        max_drawdown: lr?.max_drawdown ?? null,
        arena_score: lr?.arena_score ?? null,
        rank: lr?.rank ?? null,
        trades_count: snap?.trades_count ?? null,
      }

      // Use display_name from leaderboard_ranks
      return {
        handle: src.handle || handle,
        display_name: lr?.display_name || src.handle || handle,
        avatar_url: src.avatar_url,
        source: src.source,
        roi: metrics.roi,
        pnl: metrics.pnl,
        win_rate: normalizeWinRate(metrics.win_rate),
        max_drawdown: metrics.max_drawdown,
        arena_score: metrics.arena_score,
        rank: metrics.rank,
        trades_count: metrics.trades_count,
      }
    }

    return {
      handle: src.handle || handle,
      display_name: src.handle || handle,
      avatar_url: src.avatar_url,
      source: src.source,
      roi: metrics.roi,
      pnl: metrics.pnl,
      win_rate: normalizeWinRate(metrics.win_rate),
      max_drawdown: metrics.max_drawdown,
      arena_score: metrics.arena_score,
      rank: metrics.rank,
      trades_count: metrics.trades_count,
    }
  } catch {
    return null
  }
}
