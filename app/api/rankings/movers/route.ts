/**
 * Top Movers API
 *
 * GET /api/rankings/movers
 *
 * Returns traders with the biggest ROI changes compared to the previous day.
 * Strategy: Start from trader_daily_snapshots (yesterday) → join leaderboard_ranks (current).
 * Compares leaderboard_ranks.roi (current 90D ROI) vs trader_daily_snapshots.roi (previous).
 *
 * Response: { risers: Mover[], fallers: Mover[], period: '90D' }
 * Cache: 1 hour (s-maxage=3600)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, checkRateLimit, RateLimitPresets } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface Mover {
  platform: string
  trader_key: string
  rank: number
  arena_score: number | null
  roiDelta: number
  handle: string | null
  avatar_url: string | null
}

export async function GET(request: NextRequest) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()

    // Find the most recent date in trader_daily_snapshots
    const { data: recentDateRows } = await supabase
      .from('trader_daily_snapshots')
      .select('date')
      .order('date', { ascending: false })
      .limit(1)

    if (!recentDateRows?.length) {
      return NextResponse.json(
        { risers: [], fallers: [], period: '90D' },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
      )
    }

    const latestSnapDate = recentDateRows[0].date

    // Get yesterday's daily snapshots (most recent date available)
    // This gives us the "previous" ROI baseline for comparison
    const { data: yesterdaySnaps } = await supabase
      .from('trader_daily_snapshots')
      .select('platform, trader_key, roi')
      .eq('date', latestSnapDate)
      .not('roi', 'is', null)
      .limit(2000)

    if (!yesterdaySnaps?.length) {
      return NextResponse.json(
        { risers: [], fallers: [], period: '90D' },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
      )
    }

    // Group snapshot trader_keys by platform for efficient batch lookup
    const snapsByPlatform = new Map<string, string[]>()
    const yesterdayRoiMap = new Map<string, number>()
    for (const s of yesterdaySnaps) {
      if (s.roi == null) continue
      const key = `${s.platform}:${s.trader_key}`
      yesterdayRoiMap.set(key, parseFloat(String(s.roi)))
      if (!snapsByPlatform.has(s.platform)) snapsByPlatform.set(s.platform, [])
      snapsByPlatform.get(s.platform)!.push(s.trader_key)
    }

    // Fetch current leaderboard data for these traders, per platform
    // We look up by source (= platform) + source_trader_id (= trader_key)
    const allCurrentRanks: {
      source: string
      source_trader_id: string
      rank: number | null
      arena_score: number | null
      roi: number | null
      handle: string | null
      avatar_url: string | null
    }[] = []

    const platforms = [...snapsByPlatform.keys()]
    await Promise.all(
      platforms.map(async (platform) => {
        const traderKeys = snapsByPlatform.get(platform)!
        const { data } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, rank, arena_score, roi, handle, avatar_url')
          .eq('season_id', '90D')
          .eq('source', platform)
          .in('source_trader_id', traderKeys.slice(0, 500))
          .not('arena_score', 'is', null)
          .limit(500)
        if (data) allCurrentRanks.push(...data)
      })
    )

    if (!allCurrentRanks.length) {
      return NextResponse.json(
        { risers: [], fallers: [], period: '90D' },
        { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
      )
    }

    // Compute ROI changes: current LR roi vs yesterday's snapshot roi
    // Positive delta = ROI grew = riser; negative = faller
    const movers: Mover[] = []
    for (const r of allCurrentRanks) {
      const key = `${r.source}:${r.source_trader_id}`
      const yesterdayRoi = yesterdayRoiMap.get(key)
      if (yesterdayRoi == null || r.roi == null || r.arena_score == null) continue

      const roiDelta = r.roi - yesterdayRoi
      // Require at least 0.5% ROI change to be significant
      if (Math.abs(roiDelta) < 0.5) continue

      movers.push({
        platform: r.source,
        trader_key: r.source_trader_id,
        rank: r.rank ?? 0,
        arena_score: r.arena_score,
        roiDelta: Math.round(roiDelta * 100) / 100, // ROI point change, positive = riser
        handle: r.handle,
        avatar_url: r.avatar_url,
      })
    }

    movers.sort((a, b) => b.roiDelta - a.roiDelta)
    const risers = movers.filter((m) => m.roiDelta > 0).slice(0, 5)
    const fallers = movers.filter((m) => m.roiDelta < 0).slice(0, 5)

    return NextResponse.json(
      { risers, fallers, period: '90D', snapshotDate: latestSnapDate },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
    )
  } catch (err) {
    console.error('[movers] Error:', err instanceof Error ? err.message : String(err))
    // SECURITY: Do not leak internal error details to client
    return NextResponse.json(
      {
        risers: [],
        fallers: [],
        period: '90D',
      },
      { status: 200, headers: { 'Cache-Control': 'public, s-maxage=300' } }
    )
  }
}
