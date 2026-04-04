/**
 * Top Movers API
 *
 * GET /api/rankings/movers
 *
 * Returns traders with the biggest ROI changes compared to the previous day.
 * Strategy: Start from trader_daily_snapshots (yesterday) -> join leaderboard_ranks (current).
 * Compares leaderboard_ranks.roi (current 90D ROI) vs trader_daily_snapshots.roi (previous).
 *
 * Response: { risers: Mover[], fallers: Mover[], period: '90D' }
 * Cache: Redis 10min + HTTP 1 hour (s-maxage=3600)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, checkRateLimit, RateLimitPresets } from '@/lib/api'
import { getOrSetWithLock } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:movers')

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
    const result = await getOrSetWithLock(
      'api:rankings:movers',
      async () => computeMovers(),
      { ttl: 600, lockTtl: 15 }
    )

    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' },
    })
  } catch (err) {
    log.error('Error computing movers', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { risers: [], fallers: [], period: '90D' },
      { status: 200, headers: { 'Cache-Control': 'public, s-maxage=300' } }
    )
  }
}

async function computeMovers() {
  const supabase = getSupabaseAdmin()

  // Find the two most recent DISTINCT dates using SQL DISTINCT
  type DateRow = { date: string }
  let recentDateRows: DateRow[] | null = null
  try {
    const { data } = await supabase.rpc('get_recent_snapshot_dates', { n: 2 })
    recentDateRows = data as unknown as DateRow[] | null
  } catch { /* RPC not available */ }

  // Fallback: if RPC doesn't exist, use manual dedup
  let todayDate: string
  let yesterdayDate: string
  if (recentDateRows && recentDateRows.length >= 2) {
    todayDate = recentDateRows[0].date
    yesterdayDate = recentDateRows[1].date
  } else {
    const { data: fallbackDates } = await supabase
      .from('trader_daily_snapshots')
      .select('date')
      .order('date', { ascending: false })
      .limit(100)
    if (!fallbackDates?.length) return { risers: [], fallers: [], period: '90D' }
    const uniqueDates = [...new Set(fallbackDates.map(r => r.date))].sort().reverse()
    if (uniqueDates.length < 2) return { risers: [], fallers: [], period: '90D' }
    todayDate = uniqueDates[0]
    yesterdayDate = uniqueDates[1]
  }

  // Get PREVIOUS day's daily snapshots (to compare against current leaderboard)
  const { data: yesterdaySnaps } = await supabase
    .from('trader_daily_snapshots')
    .select('platform, trader_key, roi')
    .eq('date', yesterdayDate)
    .not('roi', 'is', null)
    .limit(2000)

  if (!yesterdaySnaps?.length) {
    return { risers: [], fallers: [], period: '90D' }
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

  // Fetch current leaderboard data — single query instead of N per-platform queries.
  // The unique index (season_id, source, source_trader_id) makes this efficient.
  const allTraderKeys = [...new Set(yesterdaySnaps.map(s => s.trader_key))]
  const { data: allCurrentRanks } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, rank, arena_score, roi, handle, avatar_url')
    .eq('season_id', '90D')
    .in('source_trader_id', allTraderKeys.slice(0, 1000))
    .not('arena_score', 'is', null)
    .limit(2000)

  if (!allCurrentRanks || allCurrentRanks.length === 0) {
    return { risers: [], fallers: [], period: '90D' }
  }

  // Compute ROI changes
  const movers: Mover[] = []
  for (const r of allCurrentRanks) {
    const key = `${r.source}:${r.source_trader_id}`
    const yesterdayRoi = yesterdayRoiMap.get(key)
    if (yesterdayRoi == null || r.roi == null || r.arena_score == null) continue

    const roiDelta = r.roi - yesterdayRoi
    if (Math.abs(roiDelta) < 0.5) continue

    movers.push({
      platform: r.source,
      trader_key: r.source_trader_id,
      rank: r.rank ?? 0,
      arena_score: r.arena_score,
      roiDelta: Math.round(roiDelta * 100) / 100,
      handle: r.handle,
      avatar_url: r.avatar_url,
    })
  }

  movers.sort((a, b) => b.roiDelta - a.roiDelta)
  const risers = movers.filter((m) => m.roiDelta > 0).slice(0, 5)
  const fallers = movers.filter((m) => m.roiDelta < 0).slice(0, 5)

  return { risers, fallers, period: '90D', snapshotDate: yesterdayDate, compareDate: todayDate }
}
