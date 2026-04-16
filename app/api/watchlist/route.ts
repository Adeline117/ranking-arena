/**
 * Trader Watchlist API
 *
 * GET  — list user's watchlist
 * POST — add trader to watchlist
 * DELETE — remove trader from watchlist (via body: { source, source_trader_id })
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:watchlist')

export const GET = withAuth(
  async ({ user, supabase }) => {
    const { data, error } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      log.error('GET query failed', { error: error.message })
      return serverError('Internal server error')
    }

    const watchlist = data || []

    // Enrich watchlist items with leaderboard snapshot data (ROI, PnL, rank, arena_score)
    if (watchlist.length > 0) {
      const { data: ranks } = await supabase
        .from('leaderboard_ranks')
        .select('source, source_trader_id, roi, pnl, rank, arena_score, win_rate, avatar_url')
        .eq('season_id', '90D')
        .in('source', [...new Set(watchlist.map(w => w.source))])
        .in('source_trader_id', [...new Set(watchlist.map(w => w.source_trader_id))])

      if (ranks && ranks.length > 0) {
        type RankRow = { source: string; source_trader_id: string; roi: unknown; pnl: unknown; rank: unknown; arena_score: unknown; win_rate: unknown; avatar_url: unknown }
        const rankMap = new Map(ranks.map(r => [`${(r as RankRow).source}:${(r as RankRow).source_trader_id}`, r as RankRow]))
        for (const item of watchlist) {
          const key = `${item.source}:${item.source_trader_id}`
          const rank = rankMap.get(key)
          if (rank) {
            Object.assign(item, {
              roi: rank.roi,
              pnl: rank.pnl,
              rank: rank.rank,
              arena_score: rank.arena_score,
              win_rate: rank.win_rate,
              avatar_url: rank.avatar_url,
            })
          }
        }
      }
    }

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    // (frontend useWatchlist reads data.watchlist directly)
    return NextResponse.json({ watchlist })
  },
  { name: 'watchlist-list', rateLimit: 'read' }
)

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { source, source_trader_id, handle } = body as { source?: string; source_trader_id?: string; handle?: string }

    if (!source || !source_trader_id || typeof source !== 'string' || typeof source_trader_id !== 'string') {
      return badRequest('source and source_trader_id required (strings)')
    }
    if (source.length > 50 || source_trader_id.length > 200) {
      return badRequest('Invalid input length')
    }

    // Enforce max watchlist size (200)
    // KEEP 'exact' — limit enforcement, scoped per-user via (user_id)
    // index. Must be accurate to block the 201st add.
    const { count } = await supabase
      .from('trader_watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    if ((count ?? 0) >= 200) {
      return badRequest('Watchlist full (max 200)')
    }

    const { error } = await supabase
      .from('trader_watchlist')
      .upsert({
        user_id: user.id,
        source,
        source_trader_id,
        handle: handle || null,
      }, {
        onConflict: 'user_id,source,source_trader_id',
      })

    if (error) {
      log.error('POST upsert failed', { error: error.message })
      return serverError('Internal server error')
    }

    // Return updated watchlist so client can mutate SWR cache immediately
    const { data: updated } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    return NextResponse.json({ watchlist: updated ?? [] })
  },
  { name: 'watchlist-add', rateLimit: 'write' }
)

export const DELETE = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }
    const { source, source_trader_id } = body as { source?: string; source_trader_id?: string }

    if (!source || !source_trader_id) {
      return badRequest('source and source_trader_id required')
    }

    const { error } = await supabase
      .from('trader_watchlist')
      .delete()
      .eq('user_id', user.id)
      .eq('source', source)
      .eq('source_trader_id', source_trader_id)

    if (error) {
      log.error('DELETE failed', { error: error.message })
      return serverError('Internal server error')
    }

    // Return updated watchlist so client can mutate SWR cache immediately
    const { data: updated } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    // Return raw NextResponse to maintain backward-compatible shape { watchlist: [...] }
    return NextResponse.json({ watchlist: updated ?? [] })
  },
  { name: 'watchlist-remove', rateLimit: 'write' }
)
