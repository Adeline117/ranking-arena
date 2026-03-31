import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:rank-history')

export const dynamic = 'force-dynamic'

/**
 * GET /api/trader/rank-history?platform=...&trader_key=...&period=90D&days=7
 *
 * Returns rank trajectory data for sparkline rendering.
 * Cached for 1 hour (s-maxage=3600).
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl
    const platform = searchParams.get('platform')
    const traderKey = searchParams.get('trader_key')
    const period = searchParams.get('period') || '90D'
    const days = Math.min(Number(searchParams.get('days') || '7'), 30)

    if (!platform || !traderKey) {
      return NextResponse.json(
        { error: 'Missing required params: platform, trader_key' },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin()

    const cutoffDate = new Date()
    cutoffDate.setDate(cutoffDate.getDate() - days)
    const cutoffISO = cutoffDate.toISOString().split('T')[0]

    const { data, error } = await supabase
      .from('rank_history')
      .select('snapshot_date, rank, arena_score')
      .eq('platform', platform)
      .eq('trader_key', traderKey)
      .eq('period', period)
      .gte('snapshot_date', cutoffISO)
      .order('snapshot_date', { ascending: true })
      .limit(days)

    if (error) {
      log.error('Query error', { error: error.message })
      return NextResponse.json(
        { error: 'Failed to fetch rank history', detail: error.message },
        { status: 500 }
      )
    }

    const history = (data || []).map(row => ({
      date: row.snapshot_date,
      rank: row.rank,
      arena_score: row.arena_score,
    }))

    return NextResponse.json(
      { history, platform, trader_key: traderKey, period },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
        },
      }
    )
  } catch (err) {
    log.error('Unexpected error', { error: err instanceof Error ? err.message : String(err) })
    return NextResponse.json(
      { error: 'Internal server error', detail: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
