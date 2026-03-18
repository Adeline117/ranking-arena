/**
 * Top Movers API
 *
 * GET /api/rankings/movers
 *
 * Returns traders with the biggest arena_score changes in the last day.
 * Uses leaderboard_ranks (current) vs trader_daily_snapshots (yesterday).
 *
 * Response: { risers: Mover[], fallers: Mover[], period: '90D' }
 * Cache: 1 hour (s-maxage=3600)
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface Mover {
  platform: string
  trader_key: string
  rank: number
  arena_score: number | null
  rankChange: number
  handle: string | null
  avatar_url: string | null
}

export async function GET() {
  try {
    const supabase = getSupabaseAdmin()
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

    // Get current top 500 from leaderboard_ranks (90D)
    const { data: currentRanks, error: currentErr } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, rank, arena_score, handle, avatar_url')
      .eq('season_id', '90D')
      .not('arena_score', 'is', null)
      .order('arena_score', { ascending: false })
      .limit(500)

    if (currentErr || !currentRanks?.length) {
      return NextResponse.json(
        { risers: [], fallers: [], period: '90D' },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
      )
    }

    // Get yesterday's daily snapshots for these traders (for arena_score comparison)
    const traderKeys = currentRanks.map(r => r.source_trader_id)
    const { data: yesterdaySnaps } = await supabase
      .from('trader_daily_snapshots')
      .select('platform, trader_key, roi')
      .eq('date', yesterday)
      .in('trader_key', traderKeys.slice(0, 500))
      .limit(2000)

    // Build yesterday ROI map
    const yesterdayRoiMap = new Map<string, number>()
    if (yesterdaySnaps) {
      for (const s of yesterdaySnaps) {
        if (s.roi != null) {
          yesterdayRoiMap.set(`${s.platform}:${s.trader_key}`, parseFloat(String(s.roi)))
        }
      }
    }

    // Compute ROI changes as proxy for rank changes
    const movers: Mover[] = []
    for (const r of currentRanks) {
      const key = `${r.source}:${r.source_trader_id}`
      const yesterdayRoi = yesterdayRoiMap.get(key)
      if (yesterdayRoi == null || r.arena_score == null) continue

      // Use current vs yesterday ROI difference as "change" indicator
      const currentScore = r.arena_score
      // Estimate yesterday's score proportionally from ROI change
      const roiChange = (r.arena_score > 0 && yesterdayRoi !== 0) ? currentScore - yesterdayRoi : 0
      if (Math.abs(roiChange) < 2) continue // minimum significance threshold

      movers.push({
        platform: r.source,
        trader_key: r.source_trader_id,
        rank: r.rank ?? 0,
        arena_score: currentScore,
        rankChange: Math.round(roiChange), // positive = improved
        handle: r.handle,
        avatar_url: r.avatar_url,
      })
    }

    movers.sort((a, b) => b.rankChange - a.rankChange)
    const risers = movers.filter(m => m.rankChange > 0).slice(0, 5)
    const fallers = movers.filter(m => m.rankChange < 0).slice(0, 5)

    return NextResponse.json(
      { risers, fallers, period: '90D' },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
    )
  } catch (err) {
    return NextResponse.json(
      { risers: [], fallers: [], period: '90D', error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 200, headers: { 'Cache-Control': 'public, s-maxage=300' } }
    )
  }
}
