/**
 * BingX enrichment: stats detail via CF Worker proxy
 *
 * BingX is WAF-protected (Cloudflare), so direct API calls fail.
 * Uses CF Worker proxy endpoint: /bingx/trader-detail?uid={uid}&timeType=2
 *
 * BingX internal API: https://api-app.qq-os.com/api/copy-trade-facade/v2/trader/new/stat
 * - timeType: 1=7d, 2=30d, 3=90d
 * - Returns: win rate, total trades, profit rate, max drawdown
 *
 * Equity curve: not available via public API -> fallback to daily snapshots.
 * Position history: not available via public API.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail, PortfolioPosition } from './enrichment-types'

const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

// ============================================
// Equity Curve
// ============================================

/**
 * BingX doesn't provide per-trader equity curve via public API.
 * Returns empty — enrichment-runner fallback to daily snapshots.
 */
export async function fetchBingxEquityCurve(
  _traderId: string,
  _days: number = 90
): Promise<EquityCurvePoint[]> {
  return []
}

// ============================================
// Stats Detail
// ============================================

interface BingXStatResponse {
  code?: number | string
  data?: {
    winRate?: number | string        // decimal 0-1
    totalTrades?: number | string
    tradeCount?: number | string
    orderCount?: number | string
    maxDrawdown?: number | string    // decimal 0-1
    mdd?: number | string
    profitRate?: number | string
    roi?: number | string
    pnl?: number | string
    followerNum?: number | string
    copyNum?: number | string
    aum?: number | string
    // Sharpe ratio fields (BingX page shows "Sharpe Ratio", API may return it)
    sharpe30d?: number | string
    sharpeRatio?: number | string
    sharpe?: number | string
    sharpRatio?: number | string
    // Some responses nest inside stat object
    stat?: {
      winRate?: number | string
      totalTrades?: number | string
      tradeCount?: number | string
      maxDrawdown?: number | string
      mdd?: number | string
      sharpe30d?: number | string
      sharpeRatio?: number | string
      sharpe?: number | string
      sharpRatio?: number | string
    }
  }
}

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

/**
 * Fetch stats from BingX via CF Worker proxy.
 * The proxy hits api-app.qq-os.com which is BingX's internal stats API.
 * timeType 3 = 90 day stats.
 */
export async function fetchBingxStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Use CF Worker proxy to bypass WAF
    const response = await fetchJson<BingXStatResponse>(
      `${PROXY_URL}/bingx/trader-detail?uid=${traderId}&timeType=3`,
      { timeoutMs: 15000 }
    )

    const data = response?.data
    const stat = data?.stat || data
    if (!stat) return null

    // winRate: decimal 0-1 → percentage
    const rawWr = safeNum(stat.winRate)
    const winRate = rawWr != null ? (Math.abs(rawWr) <= 1 ? rawWr * 100 : rawWr) : null

    // maxDrawdown: decimal 0-1 → absolute percentage
    const rawMdd = safeNum(stat.maxDrawdown ?? stat.mdd ?? (data as Record<string, unknown>)?.mdd)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    const totalTrades = safeNum(stat.totalTrades ?? stat.tradeCount ?? (data as Record<string, unknown>)?.orderCount)

    // Sharpe ratio: try multiple field names from API response
    const rawSharpe = safeNum(
      stat.sharpe30d ?? stat.sharpeRatio ?? stat.sharpe ?? stat.sharpRatio ??
      (data as Record<string, unknown>)?.sharpe30d ?? (data as Record<string, unknown>)?.sharpeRatio ??
      (data as Record<string, unknown>)?.sharpe ?? (data as Record<string, unknown>)?.sharpRatio
    )
    // BingX sharpe values should be in reasonable range (-20 to 20)
    const sharpeRatio = rawSharpe != null && rawSharpe >= -20 && rawSharpe <= 20 ? rawSharpe : null

    return {
      totalTrades: totalTrades != null ? Math.round(totalTrades) : null,
      profitableTradesPct: winRate,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio,
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: safeNum(data?.copyNum ?? data?.followerNum),
      copiersPnl: null,
      aum: safeNum(data?.aum),
      winningPositions: null,
      totalPositions: totalTrades != null ? Math.round(totalTrades) : null,
    }
  } catch (err) {
    logger.warn(`[enrichment] BingX stats detail failed for ${traderId}: ${err}`)
    return null
  }
}

// ============================================
// Current Positions
// ============================================

interface BingXPosition {
  symbol?: string
  positionSide?: string // 'Long' | 'Short'
  entryPrice?: number | string
  unrealizedProfit?: number | string
  positionAmt?: number | string
  leverage?: number | string
}

/**
 * Fetch current open positions for a BingX trader via CF Worker proxy.
 */
export async function fetchBingxCurrentPositions(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const response = await fetchJson<{ code?: number; data?: BingXPosition[] | { list?: BingXPosition[] } }>(
      `${PROXY_URL}/bingx/trader-positions?uid=${traderId}`,
      { timeoutMs: 15000 }
    )

    const list = Array.isArray(response?.data) ? response.data :
      (response?.data as { list?: BingXPosition[] })?.list || []

    if (!list.length) return []

    return list
      .filter((p): p is BingXPosition => !!p.symbol)
      .map((p) => ({
        symbol: String(p.symbol || ''),
        direction: String(p.positionSide || '').toLowerCase().includes('short') ? 'short' as const : 'long' as const,
        investedPct: null,
        entryPrice: p.entryPrice != null ? Number(p.entryPrice) : null,
        pnl: p.unrealizedProfit != null ? Number(p.unrealizedProfit) : null,
      }))
  } catch (err) {
    logger.warn(`[enrichment] BingX positions failed for ${traderId}: ${err}`)
    return []
  }
}
