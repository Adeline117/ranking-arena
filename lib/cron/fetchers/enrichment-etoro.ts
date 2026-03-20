/**
 * eToro Enrichment
 *
 * eToro provides public APIs for:
 * 1. Gain history: GET /sapi/userstats/gain/cid/{cid}/history?period={period}
 *    - Returns monthly + yearly gain data (percentage returns)
 *    - period: ThreeMonthsAgo, OneMonthAgo, CurrMonth
 * 2. Portfolio positions: GET /sapi/trade-data-real/live/public/portfolios?cid={cid}
 *    - Returns current open positions with PnL
 *
 * Notes:
 * - No auth required
 * - CustomerId (cid) is the trader_key
 * - Monthly gain data used to build equity curve
 * - Portfolio positions provide current holdings overview
 */

import type { EquityCurvePoint, StatsDetail, PortfolioPosition } from './enrichment-types'
import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

const GAIN_HISTORY_URL = 'https://www.etoro.com/sapi/userstats/gain/cid'
const PORTFOLIO_URL = 'https://www.etoro.com/sapi/trade-data-real/live/public/portfolios'
const RANKINGS_URL = 'https://www.etoro.com/sapi/rankings/rankings'

interface EtoroGainEntry {
  start: string  // ISO timestamp
  gain: number   // Percentage return
  isSimulation: boolean
}

interface EtoroGainHistory {
  customerId: number
  monthly: EtoroGainEntry[]
  yearly: EtoroGainEntry[]
}

interface EtoroPortfolioPosition {
  InstrumentID: number
  Direction: string
  Invested: number
  NetProfit: number
  Value: number
}

interface EtoroPortfolioResponse {
  AggregatedPositions: EtoroPortfolioPosition[]
  CreditByRealizedEquity: number
  CreditByUnrealizedEquity: number
}

interface EtoroRankingEntry {
  CustomerId: number
  UserName: string
  Gain: number
  WinRatio: number
  PeakToValley: number
  Copiers: number
  AUMValue: number
  RiskScore: number
}

/**
 * Fetch equity curve for an eToro trader.
 * Uses monthly gain history and converts to daily-equivalent points.
 */
export async function fetchEtoroEquityCurve(
  traderId: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const periodMap: Record<number, string> = {
      7: 'CurrMonth',
      30: 'OneMonthAgo',
      90: 'ThreeMonthsAgo',
    }
    const period = periodMap[days] || 'ThreeMonthsAgo'

    const data = await fetchJson<EtoroGainHistory>(
      `${GAIN_HISTORY_URL}/${traderId}/history?period=${period}`,
      { timeoutMs: 10000 }
    )

    if (!data?.monthly || data.monthly.length === 0) {
      logger.warn(`[etoro] Gain history empty for ${traderId}`)
      return []
    }

    // Filter to relevant period and non-simulation data
    const cutoffDate = new Date(Date.now() - days * 86400000)

    const relevantMonths = data.monthly
      .filter(m => !m.isSimulation && new Date(m.start) >= cutoffDate)
      .sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())

    if (relevantMonths.length === 0) return []

    // Convert monthly returns to cumulative equity curve
    let cumulative = 0
    const points: EquityCurvePoint[] = []

    for (const entry of relevantMonths) {
      cumulative += entry.gain
      const date = new Date(entry.start).toISOString().split('T')[0]
      points.push({
        date,
        roi: cumulative,
        pnl: null, // PnL not available from gain history
      })
    }

    return points
  } catch (err) {
    logger.warn(`[etoro] Equity curve failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

/**
 * Fetch stats detail for an eToro trader.
 * Combines ranking data (cached) with portfolio data.
 */
export async function fetchEtoroStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Get basic stats from ranking cache
    const ranking = await findTraderInRanking(traderId)

    // Get portfolio for position count
    let positionCount: number | null = null
    try {
      const portfolio = await fetchJson<EtoroPortfolioResponse>(
        `${PORTFOLIO_URL}?cid=${traderId}`,
        { timeoutMs: 8000 }
      )
      if (portfolio?.AggregatedPositions) {
        positionCount = portfolio.AggregatedPositions.length
      }
    } catch {
      // Portfolio fetch is optional
    }

    if (!ranking) {
      if (positionCount == null) return null
      return {
        totalTrades: null,
        profitableTradesPct: null,
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
        totalPositions: positionCount,
      }
    }

    const winRate = ranking.WinRatio ?? null
    const maxDrawdown = ranking.PeakToValley != null
      ? Math.abs(ranking.PeakToValley)
      : null

    return {
      totalTrades: null,
      profitableTradesPct: winRate,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: ranking.Copiers ?? null,
      copiersPnl: null,
      aum: ranking.AUMValue != null && ranking.AUMValue > 0
        ? ranking.AUMValue
        : null,
      winningPositions: null,
      totalPositions: positionCount,
    }
  } catch (err) {
    logger.warn(`[etoro] Stats detail failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

/**
 * Fetch current portfolio positions for an eToro trader.
 */
export async function fetchEtoroPortfolio(
  traderId: string
): Promise<PortfolioPosition[]> {
  try {
    const data = await fetchJson<EtoroPortfolioResponse>(
      `${PORTFOLIO_URL}?cid=${traderId}`,
      { timeoutMs: 8000 }
    )

    if (!data?.AggregatedPositions || data.AggregatedPositions.length === 0) {
      return []
    }

    return data.AggregatedPositions.map(pos => ({
      symbol: `Instrument#${pos.InstrumentID}`,
      direction: (pos.Direction || 'Buy').toLowerCase().includes('sell') ? 'short' as const : 'long' as const,
      investedPct: pos.Invested ?? null,
      entryPrice: null,
      pnl: pos.NetProfit ?? null,
    }))
  } catch (err) {
    logger.warn(`[etoro] Portfolio failed for ${traderId}: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

// Cache: traderId → EtoroRankingEntry, refreshed per batch
const traderCache = new Map<string, EtoroRankingEntry>()
let cacheTimestamp = 0
const CACHE_TTL = 5 * 60 * 1000

async function findTraderInRanking(traderId: string): Promise<EtoroRankingEntry | null> {
  if (traderCache.has(traderId) && Date.now() - cacheTimestamp < CACHE_TTL) {
    return traderCache.get(traderId) || null
  }

  await populateTraderCache()
  return traderCache.get(traderId) || null
}

async function populateTraderCache(): Promise<void> {
  if (Date.now() - cacheTimestamp < CACHE_TTL) return

  traderCache.clear()
  const maxPages = 10 // 1000 traders max (100/page)

  for (const period of ['ThreeMonthsAgo', 'OneMonthAgo']) {
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `${RANKINGS_URL}/?Period=${period}&page=${page}&pagesize=100`
        const data = await fetchJson<{ Items: EtoroRankingEntry[]; TotalRows: number }>(url, {
          timeoutMs: 10000,
        })

        if (!data?.Items || data.Items.length === 0) break

        for (const item of data.Items) {
          const id = String(item.CustomerId)
          if (id && !traderCache.has(id)) {
            traderCache.set(id, item)
          }
        }

        if (data.Items.length < 100) break
      } catch (err) {
        logger.warn(`[etoro] Cache populate page ${page} (${period}) failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }
  }

  cacheTimestamp = Date.now()
  logger.warn(`[etoro] Populated cache with ${traderCache.size} traders`)
}
