/**
 * Near-real-time rankings API
 *
 * Reads from Redis sorted set (populated by ranking-store) for instant rankings.
 * Falls back to leaderboard_ranks table if Redis sorted set is empty.
 *
 * GET /api/rankings/live?period=90D&limit=50&offset=0
 *
 * Response format matches /api/traders for frontend compatibility.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getTopTraders, getSortedSetSize } from '@/lib/realtime/ranking-store'
import { getSupabaseAdmin } from '@/lib/api'
import { createLogger } from '@/lib/utils/logger'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const logger = createLogger('rankings-live')

// ── Input validation schema ──────────────────────────────────────────────────
const liveRankingsSchema = z.object({
  period: z.string().toUpperCase().pipe(z.enum(['7D', '30D', '90D'])).catch('90D'),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
})

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const rawParams = Object.fromEntries(searchParams)
  const parsed = liveRankingsSchema.safeParse(rawParams)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { period, limit, offset } = parsed.data

  try {
    // CQRS read-through cache: avoid hitting ZREVRANGE for repeated requests within 30s
    const cacheKey = `rankings:live:${period}:${limit}:${offset}`
    const cached = await tieredGet<Record<string, unknown>>(cacheKey, 'hot')
    if (cached.data) {
      const response = NextResponse.json(cached.data)
      response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
      response.headers.set('X-Cache', 'HIT')
      response.headers.set('X-Cache-Layer', cached.layer || 'unknown')
      return response
    }

    // Try Redis sorted set first
    const sortedSetSize = await getSortedSetSize(period)

    if (sortedSetSize > 0) {
      const traders = await getTopTraders(period, limit, offset)

      if (traders.length > 0) {
        // Enrich with handles/avatars from the traders table
        const supabase = getSupabaseAdmin()
        const traderKeys = traders.map(t => t.traderKey)

        // Batch lookup enrichment data from leaderboard_ranks
        const enrichMap = new Map<string, Record<string, unknown>>()

        for (let i = 0; i < traderKeys.length; i += 100) {
          const chunk = traderKeys.slice(i, i + 100)
          const { data } = await supabase
            .from('leaderboard_ranks')
            .select('source, source_trader_id, handle, avatar_url, source_type, roi, pnl, win_rate, max_drawdown, trades_count, followers, profitability_score, risk_control_score, execution_score, trading_style, sharpe_ratio, trader_type')
            .eq('season_id', period)
            .in('source_trader_id', chunk)

          if (data) {
            for (const row of data) {
              enrichMap.set(`${(row as Record<string, unknown>).source}:${(row as Record<string, unknown>).source_trader_id}`, row as Record<string, unknown>)
            }
          }
        }

        // Build response matching /api/traders format
        const enrichedTraders = traders.map(t => {
          const enriched = enrichMap.get(`${t.platform}:${t.traderKey}`)
          return {
            id: t.traderKey,
            handle: (enriched?.handle as string) || null,
            source: t.platform,
            source_type: (enriched?.source_type as string) || 'futures',
            arena_score: t.score,
            rank: t.rank,
            roi: enriched?.roi != null ? Number(enriched.roi) : 0,
            pnl: enriched?.pnl != null ? Number(enriched.pnl) : null,
            win_rate: enriched?.win_rate != null ? Number(enriched.win_rate) : null,
            max_drawdown: enriched?.max_drawdown != null ? Number(enriched.max_drawdown) : null,
            trades_count: enriched?.trades_count != null ? Number(enriched.trades_count) : null,
            followers: enriched?.followers != null ? Number(enriched.followers) : null,
            avatar_url: (enriched?.avatar_url as string) || null,
            profitability_score: enriched?.profitability_score != null ? Number(enriched.profitability_score) : null,
            risk_control_score: enriched?.risk_control_score != null ? Number(enriched.risk_control_score) : null,
            execution_score: enriched?.execution_score != null ? Number(enriched.execution_score) : null,
            trading_style: (enriched?.trading_style as string) || null,
            sharpe_ratio: enriched?.sharpe_ratio != null ? Number(enriched.sharpe_ratio) : null,
            trader_type: (enriched?.trader_type as string) || null,
            is_bot: t.platform === 'web3_bot' || enriched?.trader_type === 'bot',
          }
        })

        const responseBody = {
          traders: enrichedTraders,
          total: sortedSetSize,
          period,
          source: 'redis',
          hasMore: offset + limit < sortedSetSize,
        }

        // Cache the response for subsequent requests (hot tier = 60s memory, 300s Redis)
        tieredSet(cacheKey, responseBody, 'hot', ['rankings', `live:${period}`]).catch(err =>
          logger.warn('[rankings/live] cache write failed:', err instanceof Error ? err.message : String(err))
        )

        const response = NextResponse.json(responseBody)
        response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
        response.headers.set('X-Cache', 'MISS')
        return response
      }
    }

    // Fallback: read from leaderboard_ranks
    logger.info(`[rankings-live] Redis sorted set empty for ${period}, falling back to DB`)
    const supabase = getSupabaseAdmin()

    const { data, count, error } = await supabase
      .from('leaderboard_ranks')
      .select('source_trader_id, handle, roi, pnl, win_rate, max_drawdown, trades_count, followers, source, source_type, avatar_url, arena_score, rank, profitability_score, risk_control_score, execution_score, trading_style, sharpe_ratio, trader_type', { count: 'estimated' })
      .eq('season_id', period)
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('rank', { ascending: true })
      .range(offset, offset + limit - 1)

    if (error) {
      logger.error('[rankings-live] DB fallback failed:', error)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    const traders = (data || []).map((row: Record<string, unknown>) => ({
      id: row.source_trader_id as string,
      handle: (row.handle as string) || null,
      source: row.source as string,
      source_type: row.source_type as string,
      arena_score: row.arena_score != null ? Number(row.arena_score) : 0,
      rank: Number(row.rank),
      roi: row.roi != null ? Number(row.roi) : 0,
      pnl: row.pnl != null ? Number(row.pnl) : null,
      win_rate: row.win_rate != null ? Number(row.win_rate) : null,
      max_drawdown: row.max_drawdown != null ? Number(row.max_drawdown) : null,
      trades_count: row.trades_count != null ? Number(row.trades_count) : null,
      followers: row.followers != null ? Number(row.followers) : null,
      avatar_url: row.avatar_url as string | null,
      profitability_score: row.profitability_score != null ? Number(row.profitability_score) : null,
      risk_control_score: row.risk_control_score != null ? Number(row.risk_control_score) : null,
      execution_score: row.execution_score != null ? Number(row.execution_score) : null,
      trading_style: (row.trading_style as string) || null,
      sharpe_ratio: row.sharpe_ratio != null ? Number(row.sharpe_ratio) : null,
      trader_type: (row.trader_type as string) || null,
      is_bot: row.source === 'web3_bot' || row.trader_type === 'bot',
    }))

    const totalCount = count ?? 0
    const responseBody = {
      traders,
      total: totalCount,
      period,
      source: 'database',
      hasMore: offset + limit < totalCount,
    }

    // Cache the DB fallback response too
    tieredSet(cacheKey, responseBody, 'hot', ['rankings', `live:${period}`]).catch(() => {})

    const response = NextResponse.json(responseBody)
    response.headers.set('Cache-Control', 'no-cache, no-store, must-revalidate')
    response.headers.set('X-Cache', 'MISS')
    return response
  } catch (error) {
    logger.error('[rankings-live] Unexpected error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
