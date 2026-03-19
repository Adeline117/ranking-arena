/**
 * Bitget enrichment: equity curve, position history, stats detail
 *
 * Uses Cloudflare Worker proxy to bypass WAF protection.
 * Strict per-request timeouts (10s) prevent the 44+ minute hangs
 * that previously caused this enrichment to be disabled.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'

const BITGET_PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

// Strict timeout for detail endpoints — prevents 44min hangs
// profitList (equity curve) gets 15s, detail endpoints get 10s
const EQUITY_TIMEOUT_MS = 15_000
const DETAIL_TIMEOUT_MS = 10_000

interface BitgetProfitLineResponse {
  code?: string
  data?: Array<{
    date?: string
    profit?: string | number
    profitRate?: string | number
  }>
}

export async function fetchBitgetEquityCurve(
  traderId: string,
  _days = 90
): Promise<EquityCurvePoint[]> {
  try {
    const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/profitList?traderId=${traderId}`
    const data = await fetchJson<BitgetProfitLineResponse>(
      `${BITGET_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`,
      { timeoutMs: EQUITY_TIMEOUT_MS }
    )

    if (!data?.data?.length) return []

    return data.data
      .filter((d) => d.date)
      .map((d) => ({
        date: d.date!,
        roi: d.profitRate != null ? Number(d.profitRate) * 100 : 0,
        pnl: d.profit != null ? Number(d.profit) : null,
      }))
  } catch (err) {
    logger.warn(`[enrichment] Bitget equity curve failed: ${err}`)
    return []
  }
}

interface BitgetPositionHistoryResponse {
  code?: string
  data?: {
    list?: Array<{
      symbol?: string
      side?: string
      openPrice?: string | number
      closePrice?: string | number
      openTime?: string | number
      closeTime?: string | number
      size?: string | number
      closedSize?: string | number
      pnl?: string | number
      pnlRate?: string | number
      leverage?: string | number
      marginMode?: string
    }>
  }
}

export async function fetchBitgetPositionHistory(
  traderId: string,
  pageSize = 50
): Promise<PositionHistoryItem[]> {
  try {
    const targetUrl = `https://www.bitget.com/v1/copy/mix/trader/detail?traderId=${traderId}`
    const data = await fetchJson<{ data?: { historyOrders?: BitgetPositionHistoryResponse['data'] } }>(
      `${BITGET_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`,
      { timeoutMs: DETAIL_TIMEOUT_MS }
    )

    const list = data?.data?.historyOrders?.list
    if (!list?.length) return []

    return list.slice(0, pageSize).map((p) => ({
      symbol: p.symbol || '',
      direction: (p.side || '').toLowerCase().includes('short') ? 'short' as const : 'long' as const,
      positionType: 'perpetual',
      marginMode: p.marginMode?.toLowerCase() || 'cross',
      openTime: p.openTime ? new Date(Number(p.openTime)).toISOString() : null,
      closeTime: p.closeTime ? new Date(Number(p.closeTime)).toISOString() : null,
      entryPrice: p.openPrice != null ? Number(p.openPrice) : null,
      exitPrice: p.closePrice != null ? Number(p.closePrice) : null,
      maxPositionSize: p.size != null ? Number(p.size) : null,
      closedSize: p.closedSize != null ? Number(p.closedSize) : null,
      pnlUsd: p.pnl != null ? Number(p.pnl) : null,
      pnlPct: p.pnlRate != null ? Number(p.pnlRate) * 100 : null,
      status: 'closed',
    }))
  } catch (err) {
    logger.warn(`[enrichment] Bitget position history failed: ${err}`)
    return []
  }
}

export async function fetchBitgetStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const targetUrl = `https://www.bitget.com/v1/trigger/trace/public/trader/detail?traderId=${traderId}`
    const data = await fetchJson<{
      data?: {
        winRate?: string | number
        maxDrawdown?: string | number
        tradeCount?: number
        followerCount?: number
        copierCount?: number
        copierPnl?: string | number
        aum?: string | number
        avgHoldingTime?: number
        sharpeRatio?: string | number
      }
    }>(
      `${BITGET_PROXY_URL}?url=${encodeURIComponent(targetUrl)}`,
      { timeoutMs: DETAIL_TIMEOUT_MS }
    )

    if (!data?.data) return null

    const d = data.data
    const parseNum = (v: string | number | undefined): number | null => {
      if (v == null) return null
      const n = typeof v === 'string' ? parseFloat(v) : Number(v)
      return isNaN(n) ? null : n
    }

    // DO NOT call fetchBitgetPositionHistory here — it was the cause of 44min hangs.
    // Stats detail is standalone. Position history is fetched separately by the runner
    // if fetchPositionHistory is configured.
    return {
      totalTrades: d.tradeCount ?? null,
      profitableTradesPct: parseNum(d.winRate),
      avgHoldingTimeHours: d.avgHoldingTime ? d.avgHoldingTime / 3600 : null,
      avgProfit: null,
      avgLoss: null,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: parseNum(d.sharpeRatio),
      maxDrawdown: parseNum(d.maxDrawdown),
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.followerCount ?? d.copierCount ?? null,
      copiersPnl: parseNum(d.copierPnl),
      aum: parseNum(d.aum),
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] Bitget stats detail failed: ${err}`)
    return null
  }
}
