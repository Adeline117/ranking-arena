/**
 * BloFin enrichment: stats detail via connector's fetchTraderSnapshot
 *
 * BloFin's public API requires auth for detail endpoints, but the connector's
 * fetchTraderSnapshot already extracts win_rate, max_drawdown, sharpe_ratio
 * from the leaderboard/trader endpoint.
 *
 * Strategy:
 * - Stats: Use openapi.blofin.com/api/v1/copytrading/public/trader/{id}?period=90
 *   which returns winRate, maxDrawdown, sharpeRatio, roi, pnl, followers
 * - Equity curve: Not available via API -> fallback to daily snapshots
 * - Position history: Not available via public API
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

const BLOFIN_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept': 'application/json',
  'Origin': 'https://blofin.com',
  'Referer': 'https://blofin.com/en/copy-trade',
}

interface BloFinTraderDetail {
  traderId?: string
  uniqueName?: string
  nickName?: string
  roi?: number | string
  pnl?: number | string
  winRate?: number | string
  maxDrawdown?: number | string
  sharpeRatio?: number | string
  followers?: number | string
  followerCount?: number | string
  copyTraderNum?: number | string
}

// ============================================
// Equity Curve
// ============================================

/**
 * BloFin doesn't provide per-trader equity curve API.
 * Returns empty — enrichment-runner fallback to daily snapshots.
 */
export async function fetchBlofinEquityCurve(
  _traderId: string,
  _days: number = 90
): Promise<EquityCurvePoint[]> {
  return []
}

// ============================================
// Stats Detail
// ============================================

function safeNum(val: unknown): number | null {
  if (val === null || val === undefined) return null
  const n = Number(val)
  return isNaN(n) ? null : n
}

/**
 * Fetch stats from BloFin's public trader detail endpoint.
 * Returns win_rate, max_drawdown, sharpe_ratio.
 *
 * Note: The API often returns 401 Unauthorized for the detail endpoint.
 * We try the leaderboard trader endpoint as primary, and CF proxy as fallback.
 */
export async function fetchBlofinStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    // Strategy 1: Direct API call to trader detail
    let info: BloFinTraderDetail | null = null

    try {
      const data = await fetchJson<{ data?: BloFinTraderDetail }>(
        `https://openapi.blofin.com/api/v1/copytrading/public/trader/${traderId}?period=90`,
        { headers: BLOFIN_HEADERS, timeoutMs: 10000 }
      )
      info = data?.data || null
    } catch {
      // Direct call failed (likely 401), try CF proxy
    }

    // Strategy 2: VPS Playwright scraper (WAF bypass)
    if (!info) {
      try {
        const scraperHost = process.env.VPS_SCRAPER_SG || process.env.VPS_SCRAPER_HOST
        const scraperKey = process.env.VPS_PROXY_KEY?.trim()
        if (scraperHost && scraperKey) {
          const data = await fetchJson<{ data?: BloFinTraderDetail }>(
            `${scraperHost}/blofin/trader-detail?uniqueCode=${traderId}`, {
              headers: { 'X-Proxy-Key': scraperKey },
              timeoutMs: 20000,
            }
          )
          info = data?.data || null
        }
      } catch {
        // VPS scraper also failed
      }
    }

    // Strategy 3: CF Worker proxy (fallback)
    if (!info) {
      try {
        const proxyUrl = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
        const data = await fetchJson<{ data?: BloFinTraderDetail }>(
          `${proxyUrl}/blofin/trader-info?uniqueCode=${traderId}`,
          { timeoutMs: 10000 }
        )
        info = data?.data || null
      } catch {
        // CF proxy also failed
      }
    }

    if (!info) return null

    // winRate and maxDrawdown from BloFin are decimals (0.65 = 65%)
    const rawWr = safeNum(info.winRate)
    const winRate = rawWr != null ? (Math.abs(rawWr) <= 1 ? rawWr * 100 : rawWr) : null

    const rawMdd = safeNum(info.maxDrawdown)
    const maxDrawdown = rawMdd != null ? Math.abs(rawMdd <= 1 ? rawMdd * 100 : rawMdd) : null

    return {
      totalTrades: null,
      profitableTradesPct: winRate,
      avgHoldingTimeHours: null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: safeNum(info.sharpeRatio),
      maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: safeNum(info.followers ?? info.followerCount ?? info.copyTraderNum),
      copiersPnl: null,
      aum: null,
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] BloFin stats detail failed for ${traderId}: ${err}`)
    return null
  }
}
