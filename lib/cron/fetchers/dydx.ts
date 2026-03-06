/**
 * dYdX v4 — Inline fetcher for Vercel serverless
 * API: Uses Cloudflare Worker proxy to bypass geo-restrictions
 *
 * Endpoints:
 * - Leaderboard: /dydx/leaderboard
 * - Historical PnL: /dydx/historical-pnl
 * - Subaccount: /dydx/subaccount
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
import { type EquityCurvePoint, type StatsDetail, upsertEquityCurve, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'dydx'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const INDEXER_URL = 'https://indexer.dydx.trade'
const TARGET = 500
const ENRICH_LIMIT = 300
const ENRICH_CONCURRENCY = 5
const ENRICH_DELAY_MS = 300

// Map periods to dYdX API format
const PERIOD_MAP: Record<string, string> = {
  '7D': 'PERIOD_7D',
  '30D': 'PERIOD_30D',
  '90D': 'PERIOD_90D',
}

// ── API response types ──

interface DydxLeaderboardEntry {
  address: string
  pnl: string
  currentEquity?: string
  rank?: number
}

interface DydxLeaderboardResponse {
  leaderboard?: DydxLeaderboardEntry[]
}

interface DydxHistoricalPnl {
  equity: string
  totalPnl: string
  netTransfers: string
  createdAt: string
}

interface DydxHistoricalPnlResponse {
  historicalPnl?: DydxHistoricalPnl[]
}

interface DydxSubaccountResponse {
  subaccount?: {
    equity?: string
    freeCollateral?: string
    openPerpetualPositions?: Record<string, unknown>
  }
}

// ── Fetch helpers ──

async function fetchLeaderboard(period: string): Promise<DydxLeaderboardEntry[]> {
  const dydxPeriod = PERIOD_MAP[period] || 'PERIOD_30D'

  // Try proxy first (for geo-blocked regions)
  try {
    const proxyUrl = `${PROXY_URL}/dydx/leaderboard?period=${dydxPeriod}&limit=${TARGET}`
    const data = await fetchJson<DydxLeaderboardResponse>(proxyUrl, { timeoutMs: 20000 })
    if (data?.leaderboard && data.leaderboard.length > 0) {
      logger.warn(`[dydx] Proxy success: ${data.leaderboard.length} entries`)
      return data.leaderboard
    }
  } catch (err) {
    logger.warn(`[dydx] Proxy failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Try direct API
  try {
    const directUrl = `${INDEXER_URL}/v4/leaderboard/pnl?period=${dydxPeriod}&limit=${TARGET}`
    const data = await fetchJson<DydxLeaderboardResponse>(directUrl, { timeoutMs: 20000 })
    if (data?.leaderboard && data.leaderboard.length > 0) {
      logger.warn(`[dydx] Direct API success: ${data.leaderboard.length} entries`)
      return data.leaderboard
    }
  } catch (err) {
    logger.warn(`[dydx] Direct API failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  return []
}

async function fetchHistoricalPnl(address: string): Promise<EquityCurvePoint[]> {
  try {
    // Try proxy first
    const proxyUrl = `${PROXY_URL}/dydx/historical-pnl?address=${address}&subaccountNumber=0&limit=90`
    const data = await fetchJson<DydxHistoricalPnlResponse>(proxyUrl, { timeoutMs: 10000 })

    if (!data?.historicalPnl || data.historicalPnl.length === 0) {
      // Try direct
      const directUrl = `${INDEXER_URL}/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=90`
      const directData = await fetchJson<DydxHistoricalPnlResponse>(directUrl, { timeoutMs: 10000 })
      if (!directData?.historicalPnl) return []
      data.historicalPnl = directData.historicalPnl
    }

    // Convert to equity curve format
    return data.historicalPnl
      .map(h => ({
        date: h.createdAt.split('T')[0],
        roi: 0, // Will calculate below
        pnl: parseFloat(h.totalPnl) || 0,
      }))
      .reverse() // API returns newest first
      .map((point, idx, arr) => {
        // Calculate ROI relative to initial equity
        const initialPnl = arr[0]?.pnl || 0
        const currentPnl = point.pnl
        const pnlDiff = currentPnl - initialPnl
        // Estimate ROI based on PnL change (assume ~$10k starting capital as reference)
        const roi = initialPnl !== 0 ? (pnlDiff / Math.abs(initialPnl)) * 100 : 0
        return { ...point, roi }
      })
  } catch (err) {
    logger.warn(`[${SOURCE}] Equity curve fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function fetchSubaccountEquity(address: string): Promise<number | null> {
  try {
    const proxyUrl = `${PROXY_URL}/dydx/subaccount?address=${address}&subaccountNumber=0`
    const data = await fetchJson<DydxSubaccountResponse>(proxyUrl, { timeoutMs: 10000 })
    if (data?.subaccount?.equity) {
      return parseFloat(data.subaccount.equity)
    }
  } catch (err) {
    logger.warn(`[${SOURCE}] Subaccount equity fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

// ── Enrichment ──

interface EnrichableTrader {
  address: string
  pnl: number
  equity: number | null
  equityCurve: EquityCurvePoint[]
  maxDrawdown: number | null
}

async function enrichTraders(traders: EnrichableTrader[]): Promise<void> {
  const toEnrich = traders.slice(0, ENRICH_LIMIT)

  for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
    const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY)
    await Promise.all(
      batch.map(async (trader) => {
        const [curve, equity] = await Promise.all([
          fetchHistoricalPnl(trader.address),
          fetchSubaccountEquity(trader.address),
        ])
        trader.equityCurve = curve
        trader.equity = equity

        // Calculate MDD from equity curve
        if (curve.length >= 2) {
          let peak = curve[0].pnl ?? 0
          let maxDD = 0
          for (const point of curve) {
            const pnl = point.pnl ?? 0
            if (pnl > peak) peak = pnl
            if (peak > 0) {
              const dd = ((peak - pnl) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          trader.maxDrawdown = maxDD > 0 && maxDD < 200 ? maxDD : null
        }
      })
    )
    await sleep(ENRICH_DELAY_MS)
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const entries = await fetchLeaderboard(period)

  if (entries.length === 0) {
    return { total: 0, saved: 0, error: 'No leaderboard data from dYdX (may be geo-blocked)' }
  }

  // Parse to enrichable format
  const parsed: EnrichableTrader[] = entries.map(e => ({
    address: e.address,
    pnl: parseFloat(e.pnl) || 0,
    equity: e.currentEquity ? parseFloat(e.currentEquity) : null,
    equityCurve: [],
    maxDrawdown: null,
  }))

  // Filter and sort
  const validTraders = parsed.filter(t => t.pnl !== 0)
  validTraders.sort((a, b) => b.pnl - a.pnl)
  const topTraders = validTraders.slice(0, TARGET)

  // Enrich with historical PnL and equity
  await enrichTraders(topTraders)

  // Phase 3: Save equity curves and stats_detail for ALL periods (extended from 90D only)
  logger.warn(`[${SOURCE}] Saving equity curves and stats details for ${period}...`)
  let curvesSaved = 0
  let statsSaved = 0
  for (const trader of topTraders.slice(0, ENRICH_LIMIT)) {
    if (trader.equityCurve.length > 0) {
      await upsertEquityCurve(supabase, SOURCE, trader.address, period, trader.equityCurve)
      curvesSaved++
    }
    // Save stats_detail
    const stats: StatsDetail = {
      totalTrades: null,
      profitableTradesPct: null,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: trader.maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: trader.equity,
      winningPositions: null,
      totalPositions: null,
    }
    const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.address, period, stats)
    if (s) statsSaved++
  }
  logger.warn(`[${SOURCE}] Saved ${curvesSaved} curves, ${statsSaved} stats for ${period}`)

  // Build TraderData
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = topTraders.map((t, idx) => {
    // Estimate ROI: PnL / equity (or assume $10k if unknown)
    const capital = t.equity || 10000
    const roi = capital > 0 ? (t.pnl / capital) * 100 : 0
    const clampedRoi = Math.max(-100, Math.min(10000, roi))

    return {
      source: SOURCE,
      source_trader_id: t.address,
      handle: `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
      profile_url: `https://dydx.trade/portfolio/${t.address}`,
      season_id: period,
      rank: idx + 1,
      roi: clampedRoi,
      pnl: t.pnl || null,
      win_rate: null,
      max_drawdown: t.maxDrawdown,
      aum: t.equity, // Save current equity as AUM
      arena_score: calculateArenaScore(clampedRoi, t.pnl, t.maxDrawdown, null, period),
      captured_at: capturedAt,
    }
  })

  const { saved, error } = await upsertTraders(supabase, traders)
  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchDydx(
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
