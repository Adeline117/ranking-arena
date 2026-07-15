/**
 * Token-level Rankings API
 *
 * GET /api/rankings/by-token?token=BTC&period=90D&limit=50&offset=0
 *   Returns traders ranked by PnL on a specific token.
 *
 * GET /api/rankings/by-token?action=popular-tokens
 *   Returns most-traded tokens by trade count from position history.
 *
 * Cache: 1 hour TTL (cold tier)
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { getSupabaseAdmin } from '@/lib/api'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { logger } from '@/lib/logger'
import { isValidTokenSymbol } from '@/lib/utils/token-symbol'
import {
  getTokenTraderRankingCacheKey,
  getTokenTraderRankings,
  type TokenTraderRanking,
} from '@/lib/rankings/token-traders'

export const runtime = 'nodejs'

interface PopularToken {
  token: string
  trade_count: number
  trader_count: number
  total_pnl: number
}

// ── Popular Tokens Handler ──────────────────────────────────────────────────
async function handlePopularTokens(): Promise<NextResponse> {
  try {
    const result = await tieredGetOrSet<PopularToken[]>(
      'rankings:popular-tokens',
      async () => {
        const supabase = getSupabaseAdmin()

        // Use AbortController with 10s timeout
        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), 10_000)

        try {
          // Use SQL aggregate via RPC — avoids fetching 50K rows into JS memory.
          // MV now filters junk at source (migration 20260709232817); 50 rows are clean.
          const { data, error } = await supabase
            .rpc('get_popular_tokens', { lookback_days: 90, max_tokens: 50 })
            .abortSignal(controller.signal)

          if (error) throw new Error(error.message)
          if (!data || data.length === 0) return []

          return (
            (
              data as Array<{
                token: string
                trade_count: number
                trader_count: number
                total_pnl: number
              }>
            )
              // U1-5: drop junk symbols (HL-107 / XYZ:TSLA / numeric ids) so the
              // token board matches the SSR list, then cap at 50.
              .filter((row) => isValidTokenSymbol(String(row.token ?? '').toUpperCase()))
              .slice(0, 50)
              .map((row) => ({
                token: row.token,
                trade_count: Number(row.trade_count),
                trader_count: Number(row.trader_count),
                total_pnl: Number(row.total_pnl),
              }))
          )
        } finally {
          clearTimeout(timeout)
        }
      },
      'cold',
      ['rankings', 'popular-tokens']
    )

    return NextResponse.json(
      { tokens: result },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
    )
  } catch (err) {
    logger.error('[popular-tokens]', err instanceof Error ? err : new Error(String(err)))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── Token Rankings Handler ──────────────────────────────────────────────────
const querySchema = z.object({
  token: z
    .string()
    .min(1)
    .max(20)
    .transform((s) => s.toUpperCase()),
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

  // Check if this is a popular-tokens request
  if (searchParams.get('action') === 'popular-tokens') {
    return handlePopularTokens()
  }

  const parsed = querySchema.safeParse(Object.fromEntries(searchParams))

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid parameters', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { token, period, limit, offset } = parsed.data

  try {
    const CACHE_KEY = getTokenTraderRankingCacheKey(token, period, limit, offset)

    const result = await tieredGetOrSet<{
      traders: TokenTraderRanking[]
      token: string
      period: string
      total: number
    }>(
      CACHE_KEY,
      async () => {
        const supabase = getSupabaseAdmin()
        const { traders, total } = await getTokenTraderRankings(
          supabase,
          token,
          period,
          limit,
          offset
        )
        return { traders, token, period, total }
      },
      'cold',
      ['rankings', 'by-token']
    )

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800',
      },
    })
  } catch (err) {
    logger.error('[by-token]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
