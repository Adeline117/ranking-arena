/**
 * POST /api/ranking-snapshot
 *
 * Creates a ranking snapshot for sharing. Inserts into ranking_snapshots
 * and snapshot_traders tables, returns a share token.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { randomBytes } from 'crypto'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { exchange, timeRange, traders, topTraderHandle, topTraderRoi } = body

    if (!traders || !Array.isArray(traders) || traders.length === 0) {
      return NextResponse.json({ error: 'traders array required' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()
    const shareToken = randomBytes(8).toString('hex')
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() // 7 days

    // Insert snapshot
    const { data: snapshot, error: snapshotError } = await supabase
      .from('ranking_snapshots')
      .insert({
        share_token: shareToken,
        time_range: timeRange || '90D',
        exchange: exchange || 'all',
        total_traders: traders.length,
        top_trader_handle: topTraderHandle || traders[0]?.handle || '',
        top_trader_roi: topTraderRoi ?? traders[0]?.roi ?? 0,
        data_captured_at: new Date().toISOString(),
        is_public: true,
        view_count: 0,
        expires_at: expiresAt,
      })
      .select('id')
      .single()

    if (snapshotError || !snapshot) {
      console.error('[ranking-snapshot] insert error:', snapshotError?.message)
      return NextResponse.json({ error: 'Failed to create snapshot' }, { status: 500 })
    }

    // Insert trader rows
    const traderRows = traders.slice(0, 50).map((tr: Record<string, unknown>) => ({
      snapshot_id: snapshot.id,
      rank: tr.rank,
      trader_id: tr.trader_id || tr.handle,
      handle: tr.handle,
      source: tr.source || '',
      roi: tr.roi ?? 0,
      pnl: tr.pnl ?? 0,
      win_rate: tr.win_rate ?? null,
      max_drawdown: tr.max_drawdown ?? null,
      arena_score: tr.arena_score ?? null,
    }))

    const { error: tradersError } = await supabase
      .from('snapshot_traders')
      .insert(traderRows)

    if (tradersError) {
      console.error('[ranking-snapshot] traders insert error:', tradersError.message)
      // Snapshot was created, just warn
    }

    return NextResponse.json({
      token: shareToken,
      url: `/s/${shareToken}`,
      expiresAt,
    })
  } catch (error) {
    console.error('[ranking-snapshot] error:', error instanceof Error ? error.message : String(error))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
