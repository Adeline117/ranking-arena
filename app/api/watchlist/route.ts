/**
 * Trader Watchlist API
 *
 * GET  — list user's watchlist
 * POST — add trader to watchlist
 * DELETE — remove trader from watchlist (via body: { source, source_trader_id })
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const log = createLogger('api:watchlist')

function getAuthenticatedUser(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer ')) return null
  return authHeader.slice(7) // access token
}

function getSupabaseWithAuth(accessToken: string) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
  return createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  })
}

export async function GET(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.read)
    if (rl) return rl

    const token = getAuthenticatedUser(request)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseWithAuth(token)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { data, error } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200)

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    const watchlist = data || []

    // Enrich watchlist items with leaderboard snapshot data (ROI, PnL, rank, arena_score)
    if (watchlist.length > 0) {
      const adminUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || ''
      const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''
      if (serviceKey) {
        const admin = createClient(adminUrl, serviceKey)
        // Build filter for all watchlist items
        const _keys = watchlist.map(w => `${w.source}:${w.source_trader_id}`)
        const { data: ranks } = await admin
          .from('leaderboard_ranks')
          .select('source, source_trader_id, roi, pnl, rank, arena_score, win_rate, avatar_url')
          .eq('season_id', '90D')
          .in('source', [...new Set(watchlist.map(w => w.source))])
          .in('source_trader_id', [...new Set(watchlist.map(w => w.source_trader_id))])

        if (ranks && ranks.length > 0) {
          const rankMap = new Map(ranks.map(r => [`${r.source}:${r.source_trader_id}`, r]))
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
    }

    return NextResponse.json({ watchlist })
  } catch (error) {
    log.error('GET failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.write)
    if (rl) return rl

    const token = getAuthenticatedUser(request)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseWithAuth(token)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { source, source_trader_id, handle } = body as { source?: string; source_trader_id?: string; handle?: string }

    if (!source || !source_trader_id || typeof source !== 'string' || typeof source_trader_id !== 'string') {
      return NextResponse.json({ error: 'source and source_trader_id required (strings)' }, { status: 400 })
    }
    if (source.length > 50 || source_trader_id.length > 200) {
      return NextResponse.json({ error: 'Invalid input length' }, { status: 400 })
    }

    // Enforce max watchlist size (200)
    const { count } = await supabase
      .from('trader_watchlist')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
    if ((count ?? 0) >= 200) {
      return NextResponse.json({ error: 'Watchlist full (max 200)' }, { status: 400 })
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
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // Return updated watchlist so client can mutate SWR cache immediately
    const { data: updated } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    return NextResponse.json({ ok: true, watchlist: updated ?? [] })
  } catch (error) {
    log.error('POST failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const rl = await checkRateLimit(request, RateLimitPresets.write)
    if (rl) return rl

    const token = getAuthenticatedUser(request)
    if (!token) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseWithAuth(token)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const { source, source_trader_id } = body as { source?: string; source_trader_id?: string }

    if (!source || !source_trader_id) {
      return NextResponse.json({ error: 'source and source_trader_id required' }, { status: 400 })
    }

    const { error } = await supabase
      .from('trader_watchlist')
      .delete()
      .eq('user_id', user.id)
      .eq('source', source)
      .eq('source_trader_id', source_trader_id)

    if (error) {
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }

    // Return updated watchlist so client can mutate SWR cache immediately
    const { data: updated } = await supabase
      .from('trader_watchlist')
      .select('source, source_trader_id, handle, created_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    return NextResponse.json({ ok: true, watchlist: updated ?? [] })
  } catch (error) {
    log.error('DELETE failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
