/**
 * MUX Protocol — Inline fetcher for Vercel serverless
 * API: The Graph decentralized network (requires THEGRAPH_API_KEY)
 * Subgraph ID: 7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR
 * Messari standard schema — accounts with positions
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'mux'
const TARGET = 500
const SUBGRAPH_ID = '7hUM4US9DPz6JqLD6ySqwFmLq4XiAF7cEZLmEesQnYgR'

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// ── API response types ──

interface MuxPosition {
  id: string
  timestampClosed?: string
  balance?: string
  collateral?: string
  realisedPnlUSD?: string
}

interface MuxAccount {
  id: string
  cumulativeClosedPositionCount: number
  cumulativePositionCount?: number
  positions?: MuxPosition[]
}

interface GraphQLResponse {
  data?: { accounts?: MuxAccount[] }
  errors?: Array<{ message: string }>
}

// ── Helpers ──

function getSubgraphUrl(): string | null {
  const apiKey = process.env.THEGRAPH_API_KEY || ''
  if (!apiKey) return null
  return `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/${SUBGRAPH_ID}`
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const subgraphUrl = getSubgraphUrl()
  if (!subgraphUrl) {
    return { total: 0, saved: 0, error: 'Missing THEGRAPH_API_KEY env var' }
  }

  const query = `
    query GetTopTraders {
      accounts(
        first: ${TARGET}
        orderBy: cumulativeClosedPositionCount
        orderDirection: desc
        where: { cumulativeClosedPositionCount_gt: 0 }
      ) {
        id
        cumulativeClosedPositionCount
        cumulativePositionCount
        positions(first: 100, orderBy: timestampClosed, orderDirection: desc) {
          id
          timestampClosed
          balance
          collateral
          realisedPnlUSD
        }
      }
    }
  `

  const json = await fetchJson<GraphQLResponse>(subgraphUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { query },
    timeoutMs: 30000,
  })

  if (json.errors?.length) {
    return { total: 0, saved: 0, error: json.errors[0].message }
  }

  const accounts = json.data?.accounts || []
  if (accounts.length === 0) {
    return { total: 0, saved: 0, error: 'No accounts returned' }
  }

  // Time window filter
  const days = WINDOW_DAYS[period] || 90
  const windowStart = Math.floor(
    (Date.now() - days * 24 * 60 * 60 * 1000) / 1000
  )

  interface ParsedMuxTrader {
    traderId: string
    nickname: string
    roi: number
    pnl: number
    winRate: number | null
    tradesCount: number
  }

  const parsed: ParsedMuxTrader[] = []

  for (const account of accounts) {
    // Filter positions within the time window
    const positions = (account.positions || []).filter(
      (p) => p.timestampClosed && parseInt(p.timestampClosed) >= windowStart
    )
    if (positions.length === 0) continue

    let totalPnl = 0
    let totalCollateral = 0
    let wins = 0

    for (const pos of positions) {
      const pnl = parseFloat(pos.realisedPnlUSD || '0')
      const collateral = parseFloat(pos.collateral || '0')
      totalPnl += pnl
      totalCollateral += collateral
      if (pnl > 0) wins++
    }

    const roi = totalCollateral > 0 ? (totalPnl / totalCollateral) * 100 : 0
    if (roi === 0) continue

    const winRate =
      positions.length > 0 ? (wins / positions.length) * 100 : null
    const id = account.id.toLowerCase()

    parsed.push({
      traderId: id,
      nickname: `${id.slice(0, 6)}...${id.slice(-4)}`,
      roi,
      pnl: totalPnl,
      winRate,
      tradesCount: positions.length,
    })
  }

  // Sort and cap
  parsed.sort((a, b) => b.roi - a.roi)
  const top = parsed.slice(0, TARGET)

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = top.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: `https://mux.network/trade?account=${t.traderId}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate,
    max_drawdown: null, // Not available from subgraph
    trades_count: t.tradesCount,
    arena_score: calculateArenaScore(t.roi, t.pnl, null, t.winRate, period),
    captured_at: capturedAt,
  }))

  const { saved, error } = await upsertTraders(supabase, traders)

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    console.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
    let statsSaved = 0
    for (const t of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: t.tradesCount ?? null,
        profitableTradesPct: t.winRate,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: t.tradesCount ?? null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, t.traderId, period, stats)
      if (s) statsSaved++
    }
    console.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchMux(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period)
      } catch (err) {
        result.periods[period] = {
          total: 0,
          saved: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      if (periods.indexOf(period) < periods.length - 1) await sleep(2000)
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  result.duration = Date.now() - start
  return result
}
