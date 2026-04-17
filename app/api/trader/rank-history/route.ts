import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { badRequest, serverError, withCache } from '@/lib/api/response'
import { createLogger } from '@/lib/utils/logger'

const log = createLogger('api:rank-history')

export const dynamic = 'force-dynamic'

/**
 * GET /api/trader/rank-history?platform=...&trader_key=...&period=90D&days=7
 *
 * Returns rank trajectory data for sparkline rendering.
 * Cached for 1 hour (s-maxage=3600).
 */
export const GET = withPublic(async ({ supabase, request }) => {
  const { searchParams } = request.nextUrl
  const platform = searchParams.get('platform')
  const traderKey = searchParams.get('trader_key')
  const period = searchParams.get('period') || '90D'
  const days = Math.min(Number(searchParams.get('days') || '7'), 30)

  if (!platform || !traderKey) {
    return badRequest('Missing required params: platform, trader_key')
  }

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
    return serverError('Failed to fetch rank history')
  }

  const history = (data || []).map(row => ({
    date: row.snapshot_date,
    rank: row.rank,
    arena_score: row.arena_score,
  }))

  // Backward-compatible response shape with cache headers
  const response = NextResponse.json(
    { history, platform, trader_key: traderKey, period }
  )
  return withCache(response, { maxAge: 3600, staleWhileRevalidate: 1800 })
}, { name: 'rank-history', rateLimit: 'public' })
