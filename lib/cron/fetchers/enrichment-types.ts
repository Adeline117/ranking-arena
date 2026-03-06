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
    return await fetchJson<T>(url, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // If geo-blocked (451) or WAF blocked (403), try proxy
    if (msg.includes('451') || msg.includes('403') || msg.includes('Access Denied')) {
      if (PROXY_URL) {
        logger.warn(`[enrichment] Geo-blocked, retrying via proxy: ${url.slice(0, 80)}...`)
        const proxyTarget = `${PROXY_URL}?url=${encodeURIComponent(url)}`
        return await fetchJson<T>(proxyTarget, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        })
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
