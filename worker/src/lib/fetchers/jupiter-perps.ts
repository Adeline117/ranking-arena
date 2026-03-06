/**
 * Jupiter Perpetuals (Solana) — Inline fetcher for Vercel serverless
 * API: https://perps-api.jup.ag/v1/top-traders
 *
 * Jupiter Perps has a public top-traders endpoint that returns:
 * - topTradersByPnl: sorted by total PnL
 * - topTradersByVolume: sorted by total volume
 *
 * Query params:
 * - marketMint: SOL, BTC, or ETH mint address
 * - year: 2024, 2025, etc.
 * - week: "current" or week number
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
import { logger } from '../../logger.js'

const SOURCE = 'jupiter_perps'
const API_BASE = 'https://perps-api.jup.ag/v1/top-traders'
const TRADES_API = 'https://perps-api.jup.ag/v1/trades'
const TARGET = 500
const ENRICH_LIMIT = 100
const ENRICH_CONCURRENCY = 5
const ENRICH_DELAY_MS = 200

// Market mints for Jupiter Perps
const MARKET_MINTS = {
  SOL: 'So11111111111111111111111111111111111111112',
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',
}

// ── API response types ──

interface JupiterTraderEntry {
  owner: string
  totalPnlUsd: string // Raw value with decimals (6 decimals)
  totalVolumeUsd: string
}

interface JupiterTopTradersResponse {
  endTimestamp: number
  startTimestamp: number
  marketMint: string
  topTradersByPnl: JupiterTraderEntry[]
  topTradersByVolume: JupiterTraderEntry[]
  totalVolumeUsd: string
}

// ── Trade history types ──

interface JupiterTrade {
  action: string // 'Increase' | 'Decrease' | 'Liquidation' etc.
  pnl: string | null
  pnlPercentage: string | null
  size: string
  fee: string
  createdTime: number
}

interface JupiterTradesResponse {
  dataList: JupiterTrade[]
  count: number
}

// ── Enrichment: fetch trade history to derive win_rate & trades_count ──

interface JupiterEnrichedStats {
  winRate: number | null
  tradesCount: number | null
  avgProfit: number | null
  avgLoss: number | null
  totalWins: number | null
  totalLosses: number | null
}

async function fetchTraderStats(owner: string): Promise<JupiterEnrichedStats> {
  const empty: JupiterEnrichedStats = {
    winRate: null, tradesCount: null, avgProfit: null, avgLoss: null, totalWins: null, totalLosses: null,
  }
  try {
    // Fetch up to 100 most recent trades (default page)
    const url = `${TRADES_API}?walletAddress=${owner}&limit=100`
    const data = await fetchJson<JupiterTradesResponse>(url, { timeoutMs: 10000 })

    if (!data?.dataList || data.dataList.length === 0) return empty

    // Only consider closing trades (Decrease, Liquidation) that have PnL
    const closingTrades = data.dataList.filter(
      (t) => t.pnl != null && t.action !== 'Increase'
    )
    if (closingTrades.length === 0) {
      return { ...empty, tradesCount: data.count || data.dataList.length }
    }

    const wins = closingTrades.filter((t) => parseFloat(t.pnl || '0') > 0)
    const losses = closingTrades.filter((t) => parseFloat(t.pnl || '0') < 0)

    let totalProfit = 0
    for (const w of wins) totalProfit += parseFloat(w.pnl || '0')
    let totalLoss = 0
    for (const l of losses) totalLoss += Math.abs(parseFloat(l.pnl || '0'))

    return {
      winRate: closingTrades.length > 0 ? (wins.length / closingTrades.length) * 100 : null,
      tradesCount: data.count || data.dataList.length,
      avgProfit: wins.length > 0 ? totalProfit / wins.length : null,
      avgLoss: losses.length > 0 ? totalLoss / losses.length : null,
      totalWins: wins.length,
      totalLosses: losses.length,
    }
  } catch {
    return empty
  }
}

// ── Helpers ──

function parseJupiterAmount(raw: string): number {
  // Jupiter amounts are in raw units with 6 decimals
  const n = parseFloat(raw)
  if (isNaN(n)) return 0
  return n / 1e6 // Convert to USD
}

function getCurrentYear(): number {
  return new Date().getFullYear()
}

// ── Fetch traders for a market ──

async function fetchMarketTraders(
  market: keyof typeof MARKET_MINTS
): Promise<JupiterTraderEntry[]> {
  const mint = MARKET_MINTS[market]
  const year = getCurrentYear()

  try {
    const url = `${API_BASE}?marketMint=${mint}&year=${year}&week=current`
    const data = await fetchJson<JupiterTopTradersResponse>(url, {
      timeoutMs: 15000,
    })

    // Merge and dedupe traders from both lists
    const traders = new Map<string, JupiterTraderEntry>()

    for (const t of data.topTradersByPnl || []) {
      if (!traders.has(t.owner)) {
        traders.set(t.owner, t)
      }
    }

    for (const t of data.topTradersByVolume || []) {
      if (!traders.has(t.owner)) {
        traders.set(t.owner, t)
      }
    }

    return Array.from(traders.values())
  } catch (err) {
    logger.warn(`[JupiterPerps] Failed to fetch ${market}:`, err)
    return []
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // Fetch all markets in parallel
  const [solTraders, ethTraders, btcTraders] = await Promise.all([
    fetchMarketTraders('SOL'),
    fetchMarketTraders('ETH'),
    fetchMarketTraders('BTC'),
  ])

  // Merge all traders, aggregating PnL and volume
  const aggregated = new Map<
    string,
    { owner: string; totalPnl: number; totalVolume: number }
  >()

  for (const traders of [solTraders, ethTraders, btcTraders]) {
    for (const t of traders) {
      const existing = aggregated.get(t.owner)
      const pnl = parseJupiterAmount(t.totalPnlUsd)
      const volume = parseJupiterAmount(t.totalVolumeUsd)

      if (existing) {
        existing.totalPnl += pnl
        existing.totalVolume += volume
      } else {
        aggregated.set(t.owner, {
          owner: t.owner,
          totalPnl: pnl,
          totalVolume: volume,
        })
      }
    }
  }

  if (aggregated.size === 0) {
    return {
      total: 0,
      saved: 0,
      error: 'No traders returned from Jupiter Perps API',
    }
  }

  // Convert to array and calculate ROI
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const t of aggregated.values()) {
    const { owner, totalPnl, totalVolume } = t

    // Estimate ROI: assume ~5x average leverage
    const estimatedCapital = totalVolume > 0 ? totalVolume / 5 : 0
    const roi =
      estimatedCapital > 100 ? (totalPnl / estimatedCapital) * 100 : totalPnl > 0 ? 5 : -5

    // Sanity bounds
    if (roi < -100 || roi > 10000) continue

    traders.push({
      source: SOURCE,
      source_trader_id: owner,
      handle: `${owner.slice(0, 4)}...${owner.slice(-4)}`,
      profile_url: `https://app.jup.ag/perps?pubkey=${owner}`,
      season_id: period,
      rank: null,
      roi: Math.max(-100, Math.min(10000, roi)),
      pnl: totalPnl || null,
      win_rate: null, // Enriched below via /v1/trades
      max_drawdown: null,
      trades_count: null,
      arena_score: calculateArenaScore(roi, totalPnl, null, null, period),
      captured_at: capturedAt,
      _owner: owner, // Preserve original casing for enrichment
    } as TraderData & { _owner: string })
  }

  // Sort by PnL descending and take top
  traders.sort((a, b) => (b.pnl ?? 0) - (a.pnl ?? 0))
  const top = traders.slice(0, TARGET)

  // Assign ranks
  top.forEach((t, i) => {
    t.rank = i + 1
  })

  // Enrich top traders with win_rate & trades_count from /v1/trades
  const toEnrich = top.slice(0, ENRICH_LIMIT) as (TraderData & { _owner: string })[]
  logger.warn(`[${SOURCE}] Enriching ${toEnrich.length} traders via /v1/trades...`)
  for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
    const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY)
    await Promise.all(
      batch.map(async (trader) => {
        const stats = await fetchTraderStats(trader._owner)
        trader.win_rate = stats.winRate
        trader.trades_count = stats.tradesCount
        // Recalculate arena score with win_rate
        trader.arena_score = calculateArenaScore(
          trader.roi ?? 0, trader.pnl ?? 0, null, stats.winRate, period
        )
        // Store enrichment data for stats_detail
        ;(trader as any)._enriched = stats
      })
    )
    await sleep(ENRICH_DELAY_MS)
  }

  // Clean up internal _owner field before upsert
  for (const t of top) {
    delete (t as any)._owner
  }

  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for all periods
  if (saved > 0) {
    logger.warn(`[${SOURCE}] Saving stats details for ${Math.min(top.length, ENRICH_LIMIT)} traders (${period})...`)
    let statsSaved = 0
    for (const trader of top.slice(0, ENRICH_LIMIT)) {
      const enriched = (trader as any)._enriched as JupiterEnrichedStats | undefined
      const stats: StatsDetail = {
        totalTrades: enriched?.tradesCount ?? null,
        profitableTradesPct: enriched?.winRate ?? null,
        avgHoldingTimeHours: null,
        avgProfit: enriched?.avgProfit ?? null,
        avgLoss: enriched?.avgLoss ?? null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: enriched?.totalWins ?? null,
        totalPositions: enriched?.tradesCount ?? null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    logger.warn(`[${SOURCE}] Saved ${statsSaved} stats details for ${period}`)
  }

  return { total: top.length, saved, error }
}

// ── Exported entry point ──

export async function fetchJupiterPerps(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

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

  result.duration = Date.now() - start
  return result
}
