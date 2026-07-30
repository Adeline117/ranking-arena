/**
 * Near-real-time rankings API
 *
 * Reads the persisted leaderboard_ranks publication authority. A short response
 * cache absorbs repeat traffic without rebuilding rank from sorted-set position.
 *
 * GET /api/rankings/live?period=90D&limit=50&offset=0
 *
 * Response format matches /api/traders for frontend compatibility.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/api'
import { readSharedCacheWriteFence } from '@/lib/cache'
import { createLogger } from '@/lib/utils/logger'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import {
  PUBLIC_RANKING_POSTGREST_EXCLUSION,
  PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY,
  PUBLIC_RANKING_REDIS_TAG,
  filterPublicRankingRows,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const logger = createLogger('rankings-live')
const PUBLIC_RANKING_RESPONSE_CACHE_CONTROL = 'private, no-store, max-age=0, must-revalidate'

// ── Input validation schema ──────────────────────────────────────────────────
const liveRankingsSchema = z.object({
  period: z
    .string()
    .toUpperCase()
    .pipe(z.enum(['7D', '30D', '90D']))
    .catch('90D'),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
})

export async function GET(request: NextRequest) {
  const rl = await checkRateLimit(request, RateLimitPresets.read)
  if (rl) return rl

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
    const writeFence = await readSharedCacheWriteFence(PUBLIC_RANKING_CACHE_WRITE_FENCE_KEY)
    // Read-through response cache for repeated requests to the same DB-authority page.
    const cacheKey = publicRankingCacheKey(`rankings:live:${period}:${limit}:${offset}`)
    const cached = await tieredGet<Record<string, unknown>>(cacheKey, 'hot', {
      skipMemory: true,
      writeFence,
    })
    if (cached.data) {
      // A policy-epoch rotation prevents older entries from being read, while
      // source sanitation also fails closed if the current epoch is polluted.
      const response = NextResponse.json(sanitizePublicRankingSourcePayload(cached.data))
      // Edge-cache the live ranking briefly so a 万级 airdrop spike is absorbed by
      // the Vercel CDN instead of every client invoking the function. The data is
      // already Redis-cached ~30s, so a 15s edge TTL + SWR keeps staleness bounded
      // (~15-45s) — acceptable for a "live" board and a huge $0 load reducer.
      // Keyed by full URL (period/limit/offset), no auth personalization.
      response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
      response.headers.set('X-Cache', 'HIT')
      response.headers.set('X-Cache-Layer', cached.layer || 'unknown')
      return response
    }

    // Persisted ranks are the publication authority. In particular, rank=NULL
    // rows must not be re-ranked from a Redis/array position on this read path.
    const supabase = getSupabaseAdmin()

    let fallbackQuery = supabase
      .from('leaderboard_ranks')
      .select(
        'source_trader_id, handle, roi, pnl, win_rate, max_drawdown, trades_count, followers, copiers, source, source_type, avatar_url, arena_score, rank, profitability_score, risk_control_score, execution_score, trading_style, sharpe_ratio, sortino_ratio, profit_factor, calmar_ratio, trader_type',
        { count: 'estimated' }
      )
      .eq('season_id', period)
      .not('rank', 'is', null)
      .in('source', [...PUBLIC_ACTIVE_RANKING_SOURCES])

    if (PUBLIC_RANKING_POSTGREST_EXCLUSION) {
      fallbackQuery = fallbackQuery.not('source', 'in', PUBLIC_RANKING_POSTGREST_EXCLUSION)
    }

    const { data, count, error } = await fallbackQuery
      .gt('arena_score', 0)
      .or('is_outlier.is.null,is_outlier.eq.false')
      .order('rank', { ascending: true })
      .range(offset, offset + limit - 1)

    if (error) {
      logger.error('[rankings-live] DB fallback failed:', error)
      return NextResponse.json({ error: 'Query failed' }, { status: 500 })
    }

    // Filter the database-native source before mapping. This prevents a legacy
    // aggregator identity from being relabelled as an active canonical source.
    const rawRows = (data || []) as Array<Record<string, unknown>>
    const publicRows = filterPublicRankingRows(rawRows, (row) => row.source).filter(
      (row) => row.rank != null
    )
    const removedNonPublicRows = publicRows.length !== rawRows.length
    const traders = publicRows.map((row) => ({
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
      is_bot:
        row.source === 'web3_bot' ||
        row.trader_type === 'bot' ||
        row.trader_type === 'suspected_bot',
    }))

    // Under a correctly behaving PostgREST response, count already reflects
    // the pre-range allowlist. If a proxy violates that filter, fail closed to
    // the finite safe page rather than publishing an untrusted aggregate.
    const totalCount = removedNonPublicRows ? traders.length : (count ?? 0)
    const responseBody = sanitizePublicRankingSourcePayload({
      traders,
      total: totalCount,
      totalCount,
      period,
      source: 'database',
      hasMore: !removedNonPublicRows && offset + limit < totalCount,
    })

    // Cache the authoritative DB response for subsequent requests.
    tieredSet(cacheKey, responseBody, 'hot', [PUBLIC_RANKING_REDIS_TAG, `live:${period}`], {
      skipMemory: true,
      writeFence,
    }).catch((err) => {
      logger.warn(
        '[rankings-live] Cache write failed:',
        err instanceof Error ? err.message : String(err)
      )
    })

    const response = NextResponse.json(responseBody)
    // Edge-cache the live ranking briefly so a 万级 airdrop spike is absorbed by
    // the Vercel CDN instead of every client invoking the function. The data is
    // already Redis-cached ~30s, so a 15s edge TTL + SWR keeps staleness bounded
    // (~15-45s) — acceptable for a "live" board and a huge $0 load reducer.
    // Keyed by full URL (period/limit/offset), no auth personalization.
    response.headers.set('Cache-Control', PUBLIC_RANKING_RESPONSE_CACHE_CONTROL)
    response.headers.set('X-Cache', 'MISS')
    return response
  } catch (error) {
    logger.error('[rankings-live] Unexpected error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
