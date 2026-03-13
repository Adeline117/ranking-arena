/**
 * Kwenta (Optimism) — Inline fetcher for Vercel serverless
 *
 * Primary: Copin API (free, no API key, 858+ traders)
 * Fallback: The Graph decentralized network (requires THEGRAPH_API_KEY)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from '../shared'
import { type StatsDetail, upsertStatsDetail } from '../enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'kwenta'
const TARGET = 500
const SUBGRAPH_ID = '5sbJJTTJQQ4kYuVYNBVw9sX8C5juRpVJNLHg7uFugw2e'

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// Copin API period mapping
const COPIN_PERIOD: Record<string, string> = { '7D': 'WEEK', '30D': 'MONTH', '90D': 'MONTH' }

// ── Copin API types ──

interface CopinTrader {
  account: string
  ranking: number
  totalPnl: number
  totalRealisedPnl: number
  totalVolume: number
  totalFee: number
  totalTrade: number
  totalWin: number
  totalLose: number
  totalLiquidation: number
}

interface CopinResponse {
  data: CopinTrader[]
  meta: { total: number; totalPages: number; limit: number; offset: number }
}

// ── TheGraph API types ──

interface KwentaPosition {
  id: string
  timestampClosed?: string
  collateral?: string
  realisedPnlUSD?: string
}

interface KwentaAccount {
  id: string
  cumulativeClosedPositionCount: number
  positions?: KwentaPosition[]
}

interface GraphQLResponse {
  data?: { accounts?: KwentaAccount[] }
  errors?: Array<{ message: string }>
}

// ── Strategy 1: Copin API (free, no key needed) ──

async function fetchViaCopinApi(period: string): Promise<TraderData[]> {
  const statisticType = COPIN_PERIOD[period] || 'MONTH'
  // Use first of current month as queryDate
  const now = new Date()
  const queryDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const traders: TraderData[] = []
  const capturedAt = new Date().toISOString()
  const pageSize = 100
  const maxPages = Math.ceil(TARGET / pageSize)

  for (let page = 0; page < maxPages; page++) {
    const url = `https://api.copin.io/leaderboards/page?protocol=KWENTA&statisticType=${statisticType}&queryDate=${queryDate}&limit=${pageSize}&offset=${page * pageSize}&sort_by=ranking&sort_type=asc`

    const data = await fetchJson<CopinResponse>(url, { timeoutMs: 15000 })
    if (!data?.data?.length) break

    for (const t of data.data) {
      if (!t.account) continue

      // Compute ROI from PnL / estimated capital (volume / avg leverage ~10x)
      const estimatedCapital = t.totalVolume > 0 ? t.totalVolume / 10 : 0
      const roi = estimatedCapital > 100 ? (t.totalPnl / estimatedCapital) * 100 : 0
      if (roi === 0 && t.totalPnl === 0) continue

      const winRate = t.totalTrade > 0 ? (t.totalWin / t.totalTrade) * 100 : null
      const addr = t.account.toLowerCase()

      traders.push({
        source: SOURCE,
        source_trader_id: addr,
        handle: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        profile_url: `https://kwenta.eth.limo/stats/${addr}`,
        season_id: period,
        rank: t.ranking || traders.length + 1,
        roi,
        pnl: t.totalPnl || null,
        win_rate: winRate,
        max_drawdown: null,
        trades_count: t.totalTrade,
        arena_score: calculateArenaScore(roi, t.totalPnl, null, winRate, period),
        captured_at: capturedAt,
      })
    }

    if (data.data.length < pageSize) break
    await sleep(300)
  }

  return traders
}

// ── Strategy 2: TheGraph (requires THEGRAPH_API_KEY) ──

function getSubgraphUrl(): string | null {
  const apiKey = process.env.THEGRAPH_API_KEY || ''
  if (!apiKey) return null
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${SUBGRAPH_ID}`
}

async function fetchViaTheGraph(period: string): Promise<TraderData[]> {
  const subgraphUrl = getSubgraphUrl()
  if (!subgraphUrl) return []

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
        positions(first: 100, orderBy: timestampClosed, orderDirection: desc) {
          id
          timestampClosed
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

  if (json.errors?.length || !json.data?.accounts?.length) return []

  const days = WINDOW_DAYS[period] || 90
  const windowStart = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000)
  const capturedAt = new Date().toISOString()

  const parsed: { id: string; roi: number; pnl: number; winRate: number | null; trades: number }[] = []

  for (const account of json.data.accounts) {
    const positions = (account.positions || []).filter(
      (p) => p.timestampClosed && parseInt(p.timestampClosed) >= windowStart
    )
    if (positions.length === 0) continue

    let totalPnl = 0, totalCollateral = 0, wins = 0
    for (const pos of positions) {
      const pnl = parseFloat(pos.realisedPnlUSD || '0')
      const collateral = parseFloat(pos.collateral || '0')
      totalPnl += pnl
      totalCollateral += collateral
      if (pnl > 0) wins++
    }

    const roi = totalCollateral > 0 ? (totalPnl / totalCollateral) * 100 : 0
    if (roi === 0) continue

    parsed.push({
      id: account.id.toLowerCase(),
      roi,
      pnl: totalPnl,
      winRate: positions.length > 0 ? (wins / positions.length) * 100 : null,
      trades: positions.length,
    })
  }

  parsed.sort((a, b) => b.roi - a.roi)

  return parsed.slice(0, TARGET).map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.id,
    handle: `${t.id.slice(0, 6)}...${t.id.slice(-4)}`,
    profile_url: `https://kwenta.eth.limo/stats/${t.id}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate,
    max_drawdown: null,
    trades_count: t.trades,
    arena_score: calculateArenaScore(t.roi, t.pnl, null, t.winRate, period),
    captured_at: capturedAt,
  }))
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // Strategy 1: Copin API (free, no key, 858+ traders)
  let traders: TraderData[] = []
  try {
    traders = await fetchViaCopinApi(period)
    if (traders.length > 0) {
      logger.info(`[${SOURCE}] Copin API returned ${traders.length} traders for ${period}`)
    }
  } catch (err) {
    logger.warn(`[${SOURCE}] Copin API failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Strategy 2: TheGraph fallback
  if (traders.length === 0) {
    try {
      traders = await fetchViaTheGraph(period)
      if (traders.length > 0) {
        logger.info(`[${SOURCE}] TheGraph returned ${traders.length} traders for ${period}`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] TheGraph failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (traders.length === 0) {
    return { total: 0, saved: 0, error: 'No data from Copin API or TheGraph' }
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for all periods
  if (saved > 0) {
    let statsSaved = 0
    for (const t of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: t.trades_count ?? null,
        profitableTradesPct: t.win_rate ?? null,
        avgHoldingTimeHours: null, avgProfit: null, avgLoss: null,
        largestWin: null, largestLoss: null, sharpeRatio: null,
        maxDrawdown: null, currentDrawdown: null, volatility: null,
        copiersCount: null, copiersPnl: null, aum: null,
        winningPositions: null, totalPositions: t.trades_count ?? null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, t.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    logger.info(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchKwenta(
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
