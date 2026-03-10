/**
 * dYdX v4 Enrichment Module
 *
 * Uses dYdX indexer for equity curves (historical PnL) and subaccount data.
 * Also fetches win_rate + trade counts from Copin API.
 */

import type { EquityCurvePoint, StatsDetail } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const INDEXER_URL = 'https://indexer.dydx.trade'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

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

// Copin trader detail API for win/loss stats
interface CopinTraderDetail {
  totalTrade?: number
  totalWin?: number
  totalLose?: number
  totalVolume?: number
  totalPnl?: number
  maxDrawdown?: number
}

/**
 * Fetch equity curve from dYdX indexer historical PnL endpoint.
 */
export async function fetchDydxEquityCurve(
  address: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    let historicalPnl: DydxHistoricalPnl[] | undefined

    // Try proxy first (geo-blocking)
    try {
      const proxyUrl = `${PROXY_URL}/dydx/historical-pnl?address=${address}&subaccountNumber=0&limit=${days}`
      const data = await fetchJson<DydxHistoricalPnlResponse>(proxyUrl, { timeoutMs: 10000 })
      historicalPnl = data?.historicalPnl
    } catch {
      // Proxy failed, try direct
    }

    if (!historicalPnl || historicalPnl.length === 0) {
      const directUrl = `${INDEXER_URL}/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=${days}`
      const directData = await fetchJson<DydxHistoricalPnlResponse>(directUrl, { timeoutMs: 10000 })
      historicalPnl = directData?.historicalPnl
    }

    if (!historicalPnl || historicalPnl.length === 0) return []

    // Convert to equity curve format (API returns newest first, reverse for ascending)
    const points = historicalPnl
      .map((h) => ({
        date: h.createdAt.split('T')[0],
        roi: 0,
        pnl: parseFloat(h.totalPnl) || 0,
      }))
      .reverse()

    // Deduplicate by date (keep last per day)
    const dateMap = new Map<string, EquityCurvePoint>()
    for (const p of points) {
      dateMap.set(p.date, p)
    }
    const deduped = [...dateMap.values()].sort((a, b) => a.date.localeCompare(b.date))

    // Compute ROI relative to first point
    if (deduped.length >= 2) {
      const initialPnl = deduped[0].pnl ?? 0
      for (const point of deduped) {
        const pnlDiff = (point.pnl ?? 0) - initialPnl
        point.roi = initialPnl !== 0 ? (pnlDiff / Math.abs(initialPnl)) * 100 : 0
      }
    }

    return deduped
  } catch (err) {
    logger.warn(`[dydx] Equity curve failed for ${address}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch stats for a dYdX trader.
 * Combines:
 * - dYdX indexer subaccount for AUM
 * - Copin API for win/loss/trade counts
 */
export async function fetchDydxStatsDetail(
  address: string
): Promise<StatsDetail | null> {
  try {
    // Fetch subaccount and Copin stats in parallel
    const [equity, copinStats] = await Promise.all([
      fetchSubaccountEquity(address),
      fetchCopinTraderStats(address),
    ])

    const totalTrades = copinStats?.totalTrade ?? null
    const totalWin = copinStats?.totalWin ?? null
    const totalLose = copinStats?.totalLose ?? null
    const profitableTradesPct = totalTrades && totalTrades > 0 && totalWin != null
      ? (totalWin / totalTrades) * 100
      : null

    return {
      totalTrades,
      profitableTradesPct: profitableTradesPct != null ? Math.round(profitableTradesPct * 10) / 10 : null,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null, // Computed from equity curve
      maxDrawdown: copinStats?.maxDrawdown != null ? Math.abs(copinStats.maxDrawdown) : null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: equity,
      winningPositions: totalWin,
      totalPositions: totalTrades,
    }
  } catch (err) {
    logger.warn(`[dydx] Stats detail failed for ${address}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function fetchSubaccountEquity(address: string): Promise<number | null> {
  try {
    const proxyUrl = `${PROXY_URL}/dydx/subaccount?address=${address}&subaccountNumber=0`
    const data = await fetchJson<DydxSubaccountResponse>(proxyUrl, { timeoutMs: 10000 })
    if (data?.subaccount?.equity) {
      return parseFloat(data.subaccount.equity)
    }
  } catch {
    // Proxy failed
  }

  try {
    const directUrl = `${INDEXER_URL}/v4/addresses/${address}/subaccounts/0`
    const data = await fetchJson<DydxSubaccountResponse>(directUrl, { timeoutMs: 10000 })
    if (data?.subaccount?.equity) {
      return parseFloat(data.subaccount.equity)
    }
  } catch (err) {
    logger.warn(`[dydx] Subaccount equity failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

async function fetchCopinTraderStats(address: string): Promise<CopinTraderDetail | null> {
  try {
    // Copin provides aggregated stats for dYdX traders
    const url = `https://api.copin.io/DYDX/position/statistic/filter?accounts=${address}&statisticType=MONTH`
    const data = await fetchJson<{ data?: CopinTraderDetail[] }>(url, { timeoutMs: 10000 })
    if (data?.data && data.data.length > 0) {
      return data.data[0]
    }
  } catch {
    // Copin API not available — not critical
  }
  return null
}
