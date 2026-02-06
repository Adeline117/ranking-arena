/**
 * Gains Network (gTrade) — Inline fetcher for Vercel serverless
 * APIs: /leaderboard (top traders with stats) + /open-trades (active positions)
 * Merged: leaderboard provides PnL/wins/losses, open-trades provides active addresses
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared.js'
import { type StatsDetail, upsertStatsDetail } from './enrichment.js'

const SOURCE = 'gains'
const API_BASE = 'https://backend-arbitrum.gains.trade'
const TARGET = 500

// ── API response types ──

interface GainsLeaderboardEntry {
  address: string
  count?: string | number
  count_win?: string | number
  count_loss?: string | number
  avg_win?: string | number
  avg_loss?: string | number
  total_pnl?: string | number
  total_pnl_usd?: string | number
}

interface GainsOpenTrade {
  trade?: {
    user?: string
    collateralAmount?: string
    collateralIndex?: string
    leverage?: string
  }
}

interface ActiveTrader {
  address: string
  openPositions: number
  totalCollateral: number
}

// ── Data fetching ──

async function fetchLeaderboardApi(): Promise<GainsLeaderboardEntry[]> {
  try {
    return await fetchJson<GainsLeaderboardEntry[]>(`${API_BASE}/leaderboard`)
  } catch {
    return []
  }
}

async function fetchOpenTradesApi(): Promise<ActiveTrader[]> {
  try {
    const trades = await fetchJson<GainsOpenTrade[]>(`${API_BASE}/open-trades`)

    const traderMap = new Map<string, ActiveTrader>()
    for (const t of trades) {
      const addr = (t.trade?.user || '').toLowerCase()
      if (!addr) continue

      if (!traderMap.has(addr)) {
        traderMap.set(addr, { address: addr, openPositions: 0, totalCollateral: 0 })
      }
      const trader = traderMap.get(addr)!
      trader.openPositions++

      // Parse collateral: index 0=DAI(18dec), 1=ETH(18dec), 2=USDC(6dec), 3=USDT(6dec)
      const collateral = parseInt(t.trade?.collateralAmount || '0')
      const collateralIndex = parseInt(t.trade?.collateralIndex || '0')
      const decimals = [18, 18, 6, 6][collateralIndex] || 6
      trader.totalCollateral += collateral / Math.pow(10, decimals)
    }

    return Array.from(traderMap.values())
  } catch {
    return []
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // Fetch both endpoints in parallel
  const [leaderboardData, openTraders] = await Promise.all([
    fetchLeaderboardApi(),
    fetchOpenTradesApi(),
  ])

  interface MergedTrader {
    traderId: string
    nickname: string
    roi: number | null
    pnl: number | null
    winRate: number | null
    tradesCount: number
    hasFullData: boolean
    // Phase 1: Additional fields for stats_detail
    avgWin: number | null
    avgLoss: number | null
    wins: number | null
    losses: number | null
  }

  const tradersMap = new Map<string, MergedTrader>()

  // 1. Add leaderboard traders (full stats)
  for (const t of leaderboardData) {
    const addr = t.address.toLowerCase()
    const totalTrades = parseInt(String(t.count || 0))
    const wins = parseInt(String(t.count_win || 0))
    const losses = parseInt(String(t.count_loss || 0))
    const totalPnl = parseFloat(String(t.total_pnl_usd || t.total_pnl || 0))
    const avgWin = parseFloat(String(t.avg_win || 0))
    const avgLoss = Math.abs(parseFloat(String(t.avg_loss || 0)))

    // Estimate capital from avg position size × trade count
    const avgPositionSize = (avgWin + avgLoss) / 2
    const estimatedCapital =
      avgPositionSize > 0 ? avgPositionSize * totalTrades : Math.abs(totalPnl)
    const roi = estimatedCapital > 0 ? (totalPnl / estimatedCapital) * 100 : 0
    const winRate = totalTrades > 0 ? (wins / totalTrades) * 100 : null

    tradersMap.set(addr, {
      traderId: addr,
      nickname: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      roi,
      pnl: totalPnl,
      winRate,
      tradesCount: totalTrades,
      hasFullData: true,
      // Phase 1: Save avg_win/avg_loss from API
      avgWin: avgWin > 0 ? avgWin : null,
      avgLoss: avgLoss > 0 ? avgLoss : null,
      wins: wins > 0 ? wins : null,
      losses: losses > 0 ? losses : null,
    })
  }

  // 2. Merge active traders from open-trades
  for (const t of openTraders) {
    if (tradersMap.has(t.address)) {
      // Already in leaderboard — just note they're active
      const existing = tradersMap.get(t.address)!
      existing.tradesCount = Math.max(existing.tradesCount, t.openPositions)
    } else {
      tradersMap.set(t.address, {
        traderId: t.address,
        nickname: `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
        roi: null,
        pnl: null,
        winRate: null,
        tradesCount: t.openPositions,
        hasFullData: false,
        avgWin: null,
        avgLoss: null,
        wins: null,
        losses: null,
      })
    }
  }

  // Sort: ONLY include traders with full data (from leaderboard)
  // Open-trades traders without stats are not useful for rankings
  const sorted = Array.from(tradersMap.values())
    .filter((t) => t.hasFullData && t.roi != null)
    .sort((a, b) => (b.roi || 0) - (a.roi || 0))
    .slice(0, TARGET)

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = sorted.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.traderId,
    handle: t.nickname,
    profile_url: `https://gains.trade/trader/${t.traderId}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl,
    win_rate: t.winRate,
    max_drawdown: null, // Not available from Gains API
    trades_count: t.tradesCount,
    arena_score: calculateArenaScore(
      t.roi || 0,
      t.pnl || 0,
      null,
      t.winRate,
      period
    ),
    captured_at: capturedAt,
  }))

  const { saved, error } = await upsertTraders(supabase, traders)

  // Save stats_detail for all periods (Phase 1: extended from 90D only)
  if (saved > 0) {
    console.warn(`[${SOURCE}] Saving stats details for top ${Math.min(sorted.length, 100)} traders (${period})...`)
    let statsSaved = 0
    for (const t of sorted.slice(0, 100)) {
      const stats: StatsDetail = {
        totalTrades: t.tradesCount ?? null,
        profitableTradesPct: t.winRate,
        avgHoldingTimeHours: null,
        // Phase 1: Save avg_win/avg_loss from API
        avgProfit: t.avgWin,
        avgLoss: t.avgLoss,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        // Phase 1: Save wins/losses count
        winningPositions: t.wins,
        totalPositions: t.tradesCount ?? null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, t.traderId, period, stats)
      if (s) statsSaved++
    }
    console.warn(`[${SOURCE}] Saved ${statsSaved} stats details for ${period}`)
  }

  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchGains(
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
