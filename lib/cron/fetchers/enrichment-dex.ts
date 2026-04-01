/**
 * DEX enrichment: Hyperliquid + GMX
 * - Position history (existing)
 * - Equity curves (derived from fills)
 * - Stats detail: win_rate, totalTrades, maxDrawdown, avgProfit/Loss (computed from fills)
 * - Asset breakdown (computed from position history)
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, PositionHistoryItem, PortfolioPosition, StatsDetail } from './enrichment-types'

// ============================================
// Shared: compute stats from position history
// ============================================

/**
 * Compute trading stats from position history fills.
 * Works for any DEX where we have closed trades with PnL.
 */
export function computeStatsFromPositions(positions: PositionHistoryItem[]): Partial<StatsDetail> {
  const withPnl = positions.filter((p) => p.pnlUsd != null)
  if (withPnl.length === 0) return {}

  const wins = withPnl.filter((p) => (p.pnlUsd ?? 0) > 0)
  const losses = withPnl.filter((p) => (p.pnlUsd ?? 0) < 0)

  const totalTrades = withPnl.length
  const winCount = wins.length
  const profitableTradesPct = totalTrades > 0 ? (winCount / totalTrades) * 100 : null

  const avgProfit = wins.length > 0
    ? wins.reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0) / wins.length
    : null
  const avgLoss = losses.length > 0
    ? losses.reduce((sum, p) => sum + (p.pnlUsd ?? 0), 0) / losses.length
    : null

  const allPnls = withPnl.map((p) => p.pnlUsd ?? 0)
  const largestWin = wins.length > 0 ? Math.max(...wins.map((p) => p.pnlUsd ?? 0)) : null
  const largestLoss = losses.length > 0 ? Math.min(...losses.map((p) => p.pnlUsd ?? 0)) : null

  // Max drawdown from cumulative PnL
  // Track peak equity and compute drawdown as percentage from peak
  let cumPnl = 0
  let peak = 0
  let maxDD = 0
  for (const pnl of allPnls) {
    cumPnl += pnl
    if (cumPnl > peak) peak = cumPnl
    // Only compute DD% when peak is positive (can't compute % drawdown from 0 or negative peak)
    if (peak > 0) {
      const dd = ((peak - cumPnl) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  // Clamp MDD to 100% (can't lose more than 100% of peak equity)
  maxDD = Math.min(maxDD, 100)

  return {
    totalTrades,
    profitableTradesPct: profitableTradesPct != null ? Math.round(profitableTradesPct * 10) / 10 : null,
    winningPositions: winCount,
    totalPositions: totalTrades,
    avgProfit: avgProfit != null ? Math.round(avgProfit * 100) / 100 : null,
    avgLoss: avgLoss != null ? Math.round(avgLoss * 100) / 100 : null,
    largestWin: largestWin != null ? Math.round(largestWin * 100) / 100 : null,
    largestLoss: largestLoss != null ? Math.round(largestLoss * 100) / 100 : null,
    maxDrawdown: maxDD > 0 ? Math.round(Math.min(maxDD, 100) * 100) / 100 : null,
  }
}

/**
 * Build equity curve from position history (cumulative PnL by day).
 * Works for any DEX with timestamped trades + PnL.
 */
export function buildEquityCurveFromPositions(
  positions: PositionHistoryItem[],
  days: number
): EquityCurvePoint[] {
  const cutoff = Date.now() - days * 86400000
  const withPnl = positions.filter(
    (p) => p.pnlUsd != null && p.closeTime != null && new Date(p.closeTime).getTime() >= cutoff
  )

  if (withPnl.length === 0) return []

  // Sort by close time ascending
  withPnl.sort((a, b) => new Date(a.closeTime!).getTime() - new Date(b.closeTime!).getTime())

  // Aggregate PnL by day
  const dailyPnl = new Map<string, number>()
  for (const p of withPnl) {
    const date = p.closeTime!.split('T')[0]
    dailyPnl.set(date, (dailyPnl.get(date) || 0) + (p.pnlUsd ?? 0))
  }

  if (dailyPnl.size === 0) return []

  const sortedDates = [...dailyPnl.keys()].sort()
  let cumPnl = 0
  const points: EquityCurvePoint[] = []

  for (const date of sortedDates) {
    cumPnl += dailyPnl.get(date) || 0
    points.push({ date, roi: 0, pnl: cumPnl })
  }

  // Estimate ROI from cumulative PnL
  const totalVolume = withPnl.reduce((sum, p) => {
    const size = p.maxPositionSize ?? p.closedSize ?? 0
    const price = p.exitPrice ?? 0
    return sum + Math.abs(size * price || p.pnlUsd || 0)
  }, 0)
  // Estimate capital as ~10% of total volume (average leverage ~10x)
  const estimatedCapital = totalVolume > 0 ? totalVolume / 10 : Math.abs(cumPnl) * 5
  if (estimatedCapital > 0) {
    for (const p of points) {
      p.roi = ((p.pnl || 0) / estimatedCapital) * 100
    }
  }

  return points
}

// ============================================
// Hyperliquid Position History (from userFills)
// ============================================

interface HyperliquidFill {
  coin?: string
  px?: string
  sz?: string
  side?: string
  time?: number
  dir?: string
  closedPnl?: string
  crossed?: boolean
  startPosition?: string
}

/**
 * Fetch raw fills from Hyperliquid API (cached for reuse across position history + equity curve + stats).
 */
async function fetchHyperliquidFills(address: string): Promise<HyperliquidFill[]> {
  const fills = await fetchJson<HyperliquidFill[]>(
    'https://api.hyperliquid.xyz/info',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'userFills', user: address },
      timeoutMs: 15000,
    }
  )
  return Array.isArray(fills) ? fills : []
}

function parseFillsToPositions(fills: HyperliquidFill[], limit = 200): PositionHistoryItem[] {
  const closingFills = fills
    .filter((f) => {
      const pnl = parseFloat(f.closedPnl || '0')
      return pnl !== 0
    })
    .slice(0, limit)

  return closingFills.map((f) => {
    const dir = (f.dir || '').toLowerCase()
    const isShort = dir.includes('short') || (dir === 'buy' && parseFloat(f.startPosition || '0') < 0)

    return {
      symbol: (f.coin || '').replace('@', 'HL-'),
      direction: isShort ? 'short' as const : 'long' as const,
      positionType: 'perpetual',
      marginMode: f.crossed ? 'cross' : 'isolated',
      openTime: null,
      closeTime: f.time ? new Date(f.time).toISOString() : null,
      entryPrice: null,
      exitPrice: f.px != null ? Number(f.px) : null,
      maxPositionSize: null,
      closedSize: f.sz != null ? Number(f.sz) : null,
      pnlUsd: f.closedPnl != null ? Number(f.closedPnl) : null,
      pnlPct: null,
      status: 'closed',
    }
  })
}

export async function fetchHyperliquidPositionHistory(
  address: string,
  limit = 200
): Promise<PositionHistoryItem[]> {
  try {
    const fills = await fetchHyperliquidFills(address)
    if (fills.length === 0) return []
    return parseFillsToPositions(fills, limit)
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid position history failed: ${err}`)
    return []
  }
}

/**
 * Fetch current portfolio (open positions) from Hyperliquid clearinghouse state.
 */
export async function fetchHyperliquidPortfolio(
  address: string,
): Promise<PortfolioPosition[]> {
  try {
    const res = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'clearinghouseState', user: address }),
    })
    if (!res.ok) return []
    const state = await res.json() as Record<string, unknown>
    const assetPositions = state.assetPositions as Array<{
      type: string
      position: {
        coin: string
        szi: string
        leverage: { type: string; value: number }
        entryPx: string
        positionValue: string
        unrealizedPnl: string
        returnOnEquity: string
        marginUsed: string
      }
    }> | undefined

    if (!assetPositions || assetPositions.length === 0) return []

    const accountValue = Number((state.marginSummary as Record<string, unknown>)?.accountValue) || 1
    return assetPositions
      .filter(ap => ap.position && Number(ap.position.szi) !== 0)
      .map(ap => {
        const pos = ap.position
        const posValue = Math.abs(Number(pos.positionValue) || 0)
        return {
          symbol: pos.coin,
          direction: Number(pos.szi) > 0 ? 'long' as const : 'short' as const,
          investedPct: accountValue > 0 ? (posValue / accountValue) * 100 : 0,
          entryPrice: Number(pos.entryPx) || null,
          pnl: Number(pos.unrealizedPnl) || null,
        }
      })
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid portfolio failed: ${err}`)
    return []
  }
}

// ============================================
// GMX Position History (from GraphQL)
// ============================================

const GMX_SUBSQUID_URL = 'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const GMX_VALUE_SCALE = 1e30

function safeBigIntToNum(val: string | number | null | undefined, scale: number): number {
  if (val == null || val === '') return 0
  try { return Number(BigInt(String(val).split('.')[0])) / scale } catch { return 0 }
}

// Common GMX v2 market address → symbol mapping (Arbitrum)
const GMX_MARKET_SYMBOLS: Record<string, string> = {
  '0x70d95587d40a2caf56bd97485ab3eec10bee6336': 'ETH/USD',
  '0x47c031236e19d024b42f8ae6780e44a573170703': 'BTC/USD',
  '0x09400d9db990d5ed3f35d7be61dfaeb900af03c9': 'SOL/USD',
  '0xd9535bb5f58a1a75032416f2dfe7880c30575a41': 'LINK/USD',
  '0xc7abb2c5f3bf3ceb389df0dcec5db73a5d3b1a5b': 'ARB/USD',
  '0x0ccb4faa6f1f1b30911619f1184082ab4e25813c': 'DOGE/USD',
  '0x2b477989a149b3d85faa5e5b264dbec7927b8a04': 'AVAX/USD',
  '0x7f1fa204bb700853d36994da19f830b6ad18455c': 'AAVE/USD',
  '0xb7e69de3a8c77d4a101a89dc24d80c6f042d2b60': 'UNI/USD',
  '0x63dc80ee90f26363b3fcd609f750bb2b95484e7a': 'ATOM/USD',
  '0xc25de3fcab3098d8e7e4de3cdccb8f2f88c04dae': 'NEAR/USD',
  '0xb686bbfdbfc1b8f1d3eca83a2ed7d0a5c4309979': 'OP/USD',
}

function resolveGmxMarketSymbol(marketAddress?: string): string {
  if (!marketAddress) return 'GMX'
  const symbol = GMX_MARKET_SYMBOLS[marketAddress.toLowerCase()]
  return symbol || marketAddress.slice(0, 10)
}

export async function fetchGmxPositionHistory(
  address: string,
  limit = 50
): Promise<PositionHistoryItem[]> {
  try {
    const query = `{
      tradeActions(
        limit: ${limit},
        where: {
          account_containsInsensitive: "${address}"
          orderType_in: [2, 4, 7]
        },
        orderBy: timestamp_DESC
      ) {
        timestamp
        orderType
        sizeDeltaUsd
        executionPrice
        isLong
        marketAddress
        basePnlUsd
      }
    }`

    const result = await fetchJson<{
      data?: {
        tradeActions?: Array<{
          timestamp: number
          orderType: number
          sizeDeltaUsd?: string
          executionPrice?: string
          isLong: boolean
          marketAddress?: string
          basePnlUsd?: string
        }>
      }
    }>(GMX_SUBSQUID_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { query },
      timeoutMs: 20000,
    })

    const actions = result?.data?.tradeActions
    if (!actions || actions.length === 0) return []

    const closingActions = actions.filter((a) => {
      if (!a.basePnlUsd) return false
      try {
        return Number(BigInt(a.basePnlUsd)) / GMX_VALUE_SCALE !== 0
      } catch (err) {
        logger.warn(`[enrichment] Error: ${err instanceof Error ? err.message : String(err)}`)
        return false
      }
    })

    return closingActions.map((a) => {
      const pnlUsd = a.basePnlUsd ? safeBigIntToNum(a.basePnlUsd, GMX_VALUE_SCALE) : null
      const sizeUsd = a.sizeDeltaUsd ? safeBigIntToNum(a.sizeDeltaUsd, GMX_VALUE_SCALE) : null
      const price = a.executionPrice ? safeBigIntToNum(a.executionPrice, 1e24) : null

      return {
        symbol: resolveGmxMarketSymbol(a.marketAddress),
        direction: a.isLong ? 'long' as const : 'short' as const,
        positionType: 'perpetual',
        marginMode: 'cross',
        openTime: null,
        closeTime: new Date(a.timestamp * 1000).toISOString(),
        entryPrice: null,
        exitPrice: price,
        maxPositionSize: sizeUsd,
        closedSize: sizeUsd,
        pnlUsd,
        pnlPct: sizeUsd && pnlUsd ? (pnlUsd / sizeUsd) * 100 : null,
        status: 'closed',
      }
    })
  } catch (err) {
    logger.warn(`[enrichment] GMX position history failed: ${err}`)
    return []
  }
}

// ============================================
// Hyperliquid Equity Curve (from daily PnL fills)
// ============================================

/**
 * Build equity curve from Hyperliquid fills by aggregating daily PnL.
 * Uses the same userFills endpoint as position history.
 */
export async function fetchHyperliquidEquityCurve(
  address: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const fills = await fetchHyperliquidFills(address)
    if (fills.length === 0) return []

    // Aggregate closedPnl by day
    const cutoff = Date.now() - days * 86400000
    const dailyPnl = new Map<string, number>()

    for (const f of fills) {
      if (!f.time || f.time < cutoff) continue
      const pnl = parseFloat(f.closedPnl || '0')
      if (pnl === 0) continue
      const date = new Date(f.time).toISOString().split('T')[0]
      dailyPnl.set(date, (dailyPnl.get(date) || 0) + pnl)
    }

    if (dailyPnl.size === 0) return []

    // Convert to cumulative ROI curve (estimate initial capital from total volume)
    const sortedDates = [...dailyPnl.keys()].sort()
    let cumPnl = 0
    const points: EquityCurvePoint[] = []

    for (const date of sortedDates) {
      cumPnl += dailyPnl.get(date) || 0
      points.push({ date, roi: 0, pnl: cumPnl })
    }

    // Estimate ROI from cumulative PnL (rough: use first day PnL as ~1% of capital)
    const firstDayPnl = Math.abs(dailyPnl.get(sortedDates[0]) || 1)
    const estimatedCapital = firstDayPnl * 100 // Assume ~1% daily moves
    if (estimatedCapital > 0) {
      for (const p of points) {
        p.roi = ((p.pnl || 0) / estimatedCapital) * 100
      }
    }

    return points
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid equity curve failed: ${err}`)
    return []
  }
}

/**
 * Hyperliquid stats from clearinghouse state + computed from fills.
 * Combines account info (AUM, open positions) with trade stats (win rate, drawdown).
 */
export async function fetchHyperliquidStatsDetail(
  address: string
): Promise<StatsDetail | null> {
  try {
    // Fetch both clearinghouse state and fills in parallel (with error tolerance)
    const results = await Promise.allSettled([
      fetchJson<{
        marginSummary?: { accountValue?: string; totalMarginUsed?: string }
        assetPositions?: Array<{ position?: { unrealizedPnl?: string; positionValue?: string } }>
      }>(
        'https://api.hyperliquid.xyz/info',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { type: 'clearinghouseState', user: address },
          timeoutMs: 10000,
        }
      ).catch(() => null),
      fetchHyperliquidFills(address).catch(() => [] as HyperliquidFill[]),
    ])
    
    const state = results[0].status === 'fulfilled' ? results[0].value : null
    const fills = results[1].status === 'fulfilled' ? results[1].value : []
    
    if (results[0].status === 'rejected') {
      logger.error(`Hyperliquid state fetch failed for ${address}`, { error: results[0].reason instanceof Error ? results[0].reason.message : String(results[0].reason) })
    }
    if (results[1].status === 'rejected') {
      logger.error(`Hyperliquid fills fetch failed for ${address}`, { error: results[1].reason instanceof Error ? results[1].reason.message : String(results[1].reason) })
    }

    const accountValue = state?.marginSummary
      ? parseFloat(state.marginSummary.accountValue || '0')
      : 0
    const openPositions = state?.assetPositions?.length || 0

    // Compute trade stats from fills
    const positions = parseFillsToPositions(fills, 500)
    const derivedStats = computeStatsFromPositions(positions)

    return {
      totalTrades: derivedStats.totalTrades ?? null,
      profitableTradesPct: derivedStats.profitableTradesPct ?? null,
      avgHoldingTimeHours: null,
      avgProfit: derivedStats.avgProfit ?? null,
      avgLoss: derivedStats.avgLoss ?? null,
      largestWin: derivedStats.largestWin ?? null,
      largestLoss: derivedStats.largestLoss ?? null,
      sharpeRatio: null, // Computed from equity curve in enhanceStatsWithDerivedMetrics
      maxDrawdown: derivedStats.maxDrawdown ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: accountValue > 0 ? accountValue : null,
      winningPositions: derivedStats.winningPositions ?? null,
      totalPositions: openPositions > 0 ? openPositions : (derivedStats.totalPositions ?? null),
    }
  } catch (err) {
    logger.warn(`[enrichment] Hyperliquid stats failed: ${err}`)
    return null
  }
}

// ============================================
// GMX Equity Curve + Stats
// ============================================

/**
 * Build GMX equity curve from position history PnL.
 */
export async function fetchGmxEquityCurve(
  address: string,
  days: number
): Promise<EquityCurvePoint[]> {
  try {
    const positions = await fetchGmxPositionHistory(address, 200)
    if (positions.length === 0) return []
    return buildEquityCurveFromPositions(positions, days)
  } catch (err) {
    logger.warn(`[enrichment] GMX equity curve failed: ${err}`)
    return []
  }
}

/**
 * GMX stats computed from position history.
 */
export async function fetchGmxStatsDetail(
  address: string
): Promise<StatsDetail | null> {
  try {
    const positions = await fetchGmxPositionHistory(address, 200)
    if (positions.length === 0) return null

    const derivedStats = computeStatsFromPositions(positions)

    return {
      totalTrades: derivedStats.totalTrades ?? null,
      profitableTradesPct: derivedStats.profitableTradesPct ?? null,
      avgHoldingTimeHours: null,
      avgProfit: derivedStats.avgProfit ?? null,
      avgLoss: derivedStats.avgLoss ?? null,
      largestWin: derivedStats.largestWin ?? null,
      largestLoss: derivedStats.largestLoss ?? null,
      sharpeRatio: null,
      maxDrawdown: derivedStats.maxDrawdown ?? null,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: null,
      winningPositions: derivedStats.winningPositions ?? null,
      totalPositions: derivedStats.totalPositions ?? null,
    }
  } catch (err) {
    logger.warn(`[enrichment] GMX stats failed: ${err}`)
    return null
  }
}
