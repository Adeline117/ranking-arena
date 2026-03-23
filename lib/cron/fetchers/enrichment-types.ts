/**
 * Enrichment shared types and proxy utilities
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'

// ============================================
// Proxy Configuration for Geo-blocked APIs
// ============================================

const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

/**
 * Fetch with proxy fallback for geo-blocked APIs (Binance, etc.)
 * First tries direct request, then falls back to proxy if geo-blocked.
 */
export async function fetchWithProxyFallback<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }
): Promise<T> {
  // Try direct first
  try {
    const directResult = await fetchJson<T>(url, opts)
    // Detect Binance geo-block (returns 200 with {code:0, msg:"Service unavailable from a restricted location"})
    const asAny = directResult as Record<string, unknown>
    if (asAny?.code === 0 && typeof asAny?.msg === 'string' && asAny.msg.includes('restricted location')) {
      throw new Error('Binance geo-blocked (200 with restricted location message)')
    }
    return directResult
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // If geo-blocked (451), WAF blocked (403), timeout, or Binance 200-geoblock, try proxies
    const isBlocked = msg.includes('451') || msg.includes('403') || msg.includes('Access Denied') || msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED') || msg.includes('geo-blocked') || msg.includes('restricted location')
    if (!isBlocked) throw err

    // Strategy 2: CF Worker proxy
    if (PROXY_URL) {
      try {
        logger.warn(`[enrichment] Blocked, retrying via CF proxy: ${url.slice(0, 80)}...`)
        const proxyTarget = `${PROXY_URL}?url=${encodeURIComponent(url)}`
        // Use GET (proxy fetches via query param, not POST body)
        return await fetchJson<T>(proxyTarget, {
          method: 'GET',
          timeoutMs: opts.timeoutMs,
        })
      } catch (cfErr) {
        logger.warn(`[enrichment] CF proxy also failed: ${cfErr instanceof Error ? cfErr.message : String(cfErr)}`)
      }
    }

    // Strategy 3: VPS proxy (bypasses WAF for Bybit, Bitget, etc.)
    const vpsUrl = process.env.VPS_PROXY_SG || process.env.VPS_PROXY_URL
    if (vpsUrl) {
      try {
        logger.warn(`[enrichment] Trying VPS proxy: ${url.slice(0, 80)}...`)
        const res = await fetch(vpsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Proxy-Key': (process.env.VPS_PROXY_KEY || '').trim(),
          },
          body: JSON.stringify({
            url,
            method: opts.method || 'GET',
            headers: opts.headers || {},
            body: opts.body ? JSON.stringify(opts.body) : undefined,
          }),
          signal: AbortSignal.timeout(opts.timeoutMs || 10_000),
        })
        if (res.ok) {
          return (await res.json()) as T
        }
        logger.warn(`[enrichment] VPS proxy returned ${res.status}`)
      } catch (vpsErr) {
        logger.warn(`[enrichment] VPS proxy failed: ${vpsErr instanceof Error ? vpsErr.message : String(vpsErr)}`)
      }
    }

    throw err
  }
}

// ============================================
// Types
// ============================================

export interface EquityCurvePoint {
  date: string // YYYY-MM-DD
  roi: number
  pnl: number | null
}

export interface PositionHistoryItem {
  symbol: string
  direction: 'long' | 'short'
  positionType: string
  marginMode: string
  openTime: string | null
  closeTime: string | null
  entryPrice: number | null
  exitPrice: number | null
  maxPositionSize: number | null
  closedSize: number | null
  pnlUsd: number | null
  pnlPct: number | null
  status: string
}

export interface EnrichmentResult {
  equityCurve: EquityCurvePoint[]
  positionHistory: PositionHistoryItem[]
  error?: string
}

// Stats Detail - 交易员详细统计数据
export interface StatsDetail {
  // 交易统计
  totalTrades: number | null
  profitableTradesPct: number | null // 盈利交易占比 (0-100)
  avgHoldingTimeHours: number | null
  avgProfit: number | null
  avgLoss: number | null
  largestWin: number | null
  largestLoss: number | null
  // 风险指标
  sharpeRatio: number | null
  maxDrawdown: number | null
  currentDrawdown: number | null
  volatility: number | null
  // ROI (optional, computed from totalPnl / totalVolume when available)
  roi?: number | null
  pnl?: number | null
  // 跟单数据
  copiersCount: number | null
  copiersPnl: number | null
  aum: number | null
  // 仓位统计
  winningPositions: number | null
  totalPositions: number | null
}

// Asset Breakdown - 资产分布
export interface AssetBreakdown {
  symbol: string
  weightPct: number
}

// Portfolio position
export interface PortfolioPosition {
  symbol: string
  direction: 'long' | 'short'
  investedPct: number | null
  entryPrice: number | null
  pnl: number | null
}
