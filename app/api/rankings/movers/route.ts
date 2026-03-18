/**
 * Top Movers API
 *
 * GET /api/rankings/movers
 *
 * Returns traders with the biggest rank changes in the last day.
 * Compares today vs yesterday rank_history snapshots for 90D period.
 *
 * Response: { risers: Mover[], fallers: Mover[], period: '90D' }
 * Cache: 1 hour (s-maxage=3600)
 */

import { NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface RankHistoryRow {
  platform: string
  trader_key: string
  rank: number
  arena_score: number | null
  snapshot_date: string
}

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

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('rank_history')
      .select('platform, trader_key, rank, arena_score, snapshot_date')
      .eq('period', '90D')
      .in('snapshot_date', [today, yesterday])
      .order('snapshot_date', { ascending: true })

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch rank history', detail: error.message },
        { status: 500 }
      )
    }

    if (!data || data.length === 0) {
      return NextResponse.json(
        { risers: [], fallers: [], period: '90D' },
        {
          headers: {
            'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
          },
        }
      )
    }

    // Partition rows by date
    const todayMap = new Map<string, RankHistoryRow>()
    const yesterdayMap = new Map<string, RankHistoryRow>()
    for (const row of data as RankHistoryRow[]) {
      const key = `${row.platform}:${row.trader_key}`
      if (row.snapshot_date === today) todayMap.set(key, row)
      else yesterdayMap.set(key, row)
    }

    // Compute rank changes
    const movers: Array<RankHistoryRow & { rankChange: number }> = []
    for (const [key, todayRow] of todayMap) {
      const yesterdayRow = yesterdayMap.get(key)
      if (!yesterdayRow) continue
      const rankChange = yesterdayRow.rank - todayRow.rank // positive = improved
      if (Math.abs(rankChange) >= 5) {
        movers.push({ ...todayRow, rankChange })
      }
    }

    // Sort: biggest risers first, then biggest fallers
    movers.sort((a, b) => b.rankChange - a.rankChange)
    const risers = movers.filter(m => m.rankChange > 0).slice(0, 5)
    const fallers = movers.filter(m => m.rankChange < 0).slice(0, 5)

    // Batch-fetch handles for all movers
    const allMovers = [...risers, ...fallers]
    const traderKeys = allMovers.map(m => m.trader_key)

    let handleMap = new Map<string, { handle: string | null; avatar_url: string | null }>()
    if (traderKeys.length > 0) {
      const { data: traders } = await supabase
        .from('trader_sources')
        .select('source, source_trader_id, handle, avatar_url')
        .in('source_trader_id', traderKeys)

      if (traders) {
        for (const t of traders) {
          const key = `${t.source}:${t.source_trader_id}`
          handleMap.set(key, { handle: t.handle, avatar_url: t.avatar_url })
        }
      }
    }

    // Merge handles into movers
    const enrichMover = (m: RankHistoryRow & { rankChange: number }): Mover => {
      const key = `${m.platform}:${m.trader_key}`
      const info = handleMap.get(key)
      return {
        platform: m.platform,
        trader_key: m.trader_key,
        rank: m.rank,
        arena_score: m.arena_score,
        rankChange: m.rankChange,
        handle: info?.handle ?? null,
        avatar_url: info?.avatar_url ?? null,
      }
    }

    return NextResponse.json(
      {
        risers: risers.map(enrichMover),
        fallers: fallers.map(enrichMover),
        period: '90D',
      },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
        },
      }
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json(
      { error: 'Internal server error', detail: message },
      { status: 500 }
    )
  }
}
