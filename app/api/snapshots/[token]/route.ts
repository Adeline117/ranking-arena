/**
 * Fetch Snapshot by Share Token API
 *
 * GET /api/snapshots/[token] - Get a snapshot by its share token
 *
 * This endpoint is public - anyone with the link can view the snapshot
 */

import { NextResponse, NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('snapshot-fetch-api')

export const dynamic = 'force-dynamic'

interface Params {
  params: Promise<{ token: string }>
}

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { token } = await params

    if (!token || token.length < 6) {
      return NextResponse.json(
        { success: false, error: 'Invalid snapshot token' },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()

    // Fetch snapshot metadata
    const { data: snapshot, error: snapshotError } = await supabase
      .from('ranking_snapshots')
      .select(`
        id,
        share_token,
        time_range,
        exchange,
        category,
        total_traders,
        top_trader_handle,
        top_trader_roi,
        data_captured_at,
        data_delay_minutes,
        is_public,
        view_count,
        expires_at,
        title,
        description,
        created_at
      `)
      .eq('share_token', token)
      .single()

    if (snapshotError || !snapshot) {
      logger.warn('Snapshot not found', { token })
      return NextResponse.json(
        { success: false, error: 'Snapshot not found' },
        { status: 404 }
      )
    }

    // Check if snapshot is public
    if (!snapshot.is_public) {
      return NextResponse.json(
        { success: false, error: 'This snapshot is private' },
        { status: 403 }
      )
    }

    // Check if snapshot is expired
    if (snapshot.expires_at && new Date(snapshot.expires_at) < new Date()) {
      return NextResponse.json(
        { success: false, error: 'This snapshot has expired', isExpired: true },
        { status: 410 }
      )
    }

    // Fetch traders in the snapshot
    const { data: traders, error: tradersError } = await supabase
      .from('snapshot_traders')
      .select(`
        rank,
        trader_id,
        handle,
        source,
        avatar_url,
        roi,
        pnl,
        win_rate,
        max_drawdown,
        trades_count,
        followers,
        arena_score,
        return_score,
        drawdown_score,
        stability_score,
        data_availability
      `)
      .eq('snapshot_id', snapshot.id)
      .order('rank', { ascending: true })

    if (tradersError) {
      logger.error('Failed to fetch snapshot traders', { error: tradersError.message })
      return NextResponse.json(
        { success: false, error: 'Failed to fetch snapshot data' },
        { status: 500 }
      )
    }

    // Increment view count (fire and forget)
    void Promise.resolve(
      supabase.rpc('increment_snapshot_view_count', { snapshot_share_token: token })
    ).catch(() => { /* View count increment is fire-and-forget */ })

    const response = NextResponse.json({
      success: true,
      data: {
        snapshot: {
          id: snapshot.id,
          shareToken: snapshot.share_token,
          timeRange: snapshot.time_range,
          exchange: snapshot.exchange,
          category: snapshot.category,
          totalTraders: snapshot.total_traders,
          topTrader: {
            handle: snapshot.top_trader_handle,
            roi: snapshot.top_trader_roi,
          },
          dataCapturedAt: snapshot.data_captured_at,
          dataDelayMinutes: snapshot.data_delay_minutes,
          viewCount: snapshot.view_count,
          expiresAt: snapshot.expires_at,
          title: snapshot.title,
          description: snapshot.description,
          createdAt: snapshot.created_at,
        },
        traders: traders?.map(t => ({
          rank: t.rank,
          id: t.trader_id,
          handle: t.handle,
          source: t.source,
          avatarUrl: t.avatar_url,
          roi: t.roi,
          pnl: t.pnl,
          winRate: t.win_rate,
          maxDrawdown: t.max_drawdown,
          tradesCount: t.trades_count,
          followers: t.followers,
          arenaScore: t.arena_score,
          returnScore: t.return_score,
          drawdownScore: t.drawdown_score,
          stabilityScore: t.stability_score,
          dataAvailability: t.data_availability,
        })) || [],
      },
    })
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  } catch (error: unknown) {
    logger.error('Snapshot fetch failed', { error: String(error) })
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
