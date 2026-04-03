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
import { tieredGetOrSet } from '@/lib/cache/redis-layer'

export const runtime = 'nodejs'

// Map period to a lookback window in days
const PERIOD_DAYS: Record<string, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

// Normalize a raw symbol to a base token (e.g. BTCUSDT -> BTC, ETH/USD -> ETH)
function extractBaseToken(symbol: string): string {
  const s = symbol.toUpperCase()
  // Remove common suffixes
  for (const suffix of ['USDT.P', 'USDT', 'BUSD', 'USD', '-PERP', '-USD']) {
    if (s.endsWith(suffix)) return s.slice(0, -suffix.length)
  }
  // Handle slash notation: BTC/USDT -> BTC
  if (s.includes('/')) return s.split('/')[0]
  return s
}

interface TokenTrader {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  total_pnl: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
}

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
        const cutoff = new Date()
        cutoff.setDate(cutoff.getDate() - 90)

        // Fetch recent positions with symbols
        const { data, error } = await supabase
          .from('trader_position_history')
          .select('symbol, source, source_trader_id, pnl_usd')
          .gte('close_time', cutoff.toISOString())
          .not('pnl_usd', 'is', null)
          .limit(50000)

        if (error) throw new Error(error.message)
        if (!data || data.length === 0) return []

        // Aggregate by base token
        const tokenMap = new Map<string, {
          tradeCount: number
          traders: Set<string>
          totalPnl: number
        }>()

        for (const row of data as Array<{ symbol: string; source: string; source_trader_id: string; pnl_usd: number | null }>) {
          const baseToken = extractBaseToken(row.symbol)
          if (!baseToken || baseToken.length > 10) continue

          if (!tokenMap.has(baseToken)) {
            tokenMap.set(baseToken, { tradeCount: 0, traders: new Set(), totalPnl: 0 })
          }
          const acc = tokenMap.get(baseToken)!
          acc.tradeCount++
          acc.traders.add(`${row.source}:${row.source_trader_id}`)
          acc.totalPnl += Number(row.pnl_usd) || 0
        }

        return [...tokenMap.entries()]
          .map(([token, acc]) => ({
            token,
            trade_count: acc.tradeCount,
            trader_count: acc.traders.size,
            total_pnl: Math.round(acc.totalPnl * 100) / 100,
          }))
          .sort((a, b) => b.trade_count - a.trade_count)
          .slice(0, 50) // Top 50 tokens
      },
      'cold',
      ['rankings', 'popular-tokens']
    )

    return NextResponse.json(
      { tokens: result },
      { headers: { 'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=1800' } }
    )
  } catch (_err) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ── Token Rankings Handler ──────────────────────────────────────────────────
const querySchema = z.object({
  token: z.string().min(1).max(20).transform(s => s.toUpperCase()),
  period: z.string().toUpperCase().pipe(z.enum(['7D', '30D', '90D'])).catch('90D'),
  limit: z.coerce.number().int().min(1).max(200).catch(50),
  offset: z.coerce.number().int().min(0).catch(0),
})

export async function GET(request: NextRequest) {
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
    const CACHE_KEY = `rankings:by-token:${token}:${period}:${limit}:${offset}`

    const result = await tieredGetOrSet<{ traders: TokenTrader[]; token: string; period: string; total: number }>(
      CACHE_KEY,
      async () => {
        const supabase = getSupabaseAdmin()
        const lookbackDays = PERIOD_DAYS[period] || 90
        const cutoffDate = new Date()
        cutoffDate.setDate(cutoffDate.getDate() - lookbackDays)
        const cutoffISO = cutoffDate.toISOString()

        // Fetch position history rows matching the token symbol patterns
        const allRows: Array<{
          source: string
          source_trader_id: string
          pnl_usd: number | null
          pnl_pct: number | null
        }> = []

        // Query each common symbol format individually with .eq() (indexed, fast)
        // ilike('symbol', 'BTC%') causes statement timeout on large tables
        const symbolVariants = [
          `${token}USDT`, `${token}USDT.P`, `${token}USD`,
          `${token}/USDT`, `${token}/USD`, `${token}-PERP`,
        ]

        // Run queries in parallel, each with .eq() for index usage
        const results = await Promise.allSettled(
          symbolVariants.map(sym =>
            supabase
              .from('trader_position_history')
              .select('source, source_trader_id, pnl_usd, pnl_pct')
              .eq('symbol', sym)
              .gte('close_time', cutoffISO)
              .not('pnl_usd', 'is', null)
              .limit(500)
          )
        )

        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.data) {
            allRows.push(...(r.value.data as typeof allRows))
          }
        }

        if (allRows.length === 0) {
          return { traders: [], token, period, total: 0 }
        }

        // Aggregate by (source, source_trader_id)
        const traderMap = new Map<string, {
          source: string
          source_trader_id: string
          totalPnl: number
          tradeCount: number
          winCount: number
          pnlPcts: number[]
        }>()

        for (const row of allRows) {
          const key = `${row.source}:${row.source_trader_id}`
          if (!traderMap.has(key)) {
            traderMap.set(key, {
              source: row.source,
              source_trader_id: row.source_trader_id,
              totalPnl: 0,
              tradeCount: 0,
              winCount: 0,
              pnlPcts: [],
            })
          }
          const acc = traderMap.get(key)!
          const pnl = Number(row.pnl_usd) || 0
          acc.totalPnl += pnl
          acc.tradeCount++
          if (pnl > 0) acc.winCount++
          if (row.pnl_pct != null) acc.pnlPcts.push(Number(row.pnl_pct))
        }

        // Sort by total PnL descending
        const sorted = [...traderMap.values()].sort((a, b) => b.totalPnl - a.totalPnl)
        const total = sorted.length
        const page = sorted.slice(offset, offset + limit)

        if (page.length === 0) {
          return { traders: [], token, period, total }
        }

        // Enrich with leaderboard_ranks data
        const traderIds = page.map(t => t.source_trader_id)
        const { data: lrData } = await supabase
          .from('leaderboard_ranks')
          .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl')
          .eq('season_id', period)
          .in('source_trader_id', traderIds)

        const lrMap = new Map<string, {
          handle: string | null
          avatar_url: string | null
          arena_score: number | null
          roi: number | null
          pnl: number | null
        }>()

        if (lrData) {
          for (const row of lrData as Array<Record<string, unknown>>) {
            const key = `${row.source}:${row.source_trader_id}`
            lrMap.set(key, {
              handle: (row.handle as string) || null,
              avatar_url: (row.avatar_url as string) || null,
              arena_score: row.arena_score != null ? Number(row.arena_score) : null,
              roi: row.roi != null ? Number(row.roi) : null,
              pnl: row.pnl != null ? Number(row.pnl) : null,
            })
          }
        }

        const traders: TokenTrader[] = page.map(t => {
          const key = `${t.source}:${t.source_trader_id}`
          const lr = lrMap.get(key)
          const avgPnlPct = t.pnlPcts.length > 0
            ? t.pnlPcts.reduce((s, v) => s + v, 0) / t.pnlPcts.length
            : null

          return {
            source: t.source,
            source_trader_id: t.source_trader_id,
            handle: lr?.handle || null,
            avatar_url: lr?.avatar_url || null,
            arena_score: lr?.arena_score || null,
            roi: lr?.roi || null,
            total_pnl: lr?.pnl != null ? Number(lr.pnl) : 0,
            token_pnl: Math.round(t.totalPnl * 100) / 100,
            token_trade_count: t.tradeCount,
            token_win_rate: t.tradeCount > 0
              ? Math.round((t.winCount / t.tradeCount) * 10000) / 100
              : null,
            token_avg_pnl_pct: avgPnlPct != null ? Math.round(avgPnlPct * 100) / 100 : null,
          }
        })

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
    console.error('[by-token]', err instanceof Error ? err.message : String(err))
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
