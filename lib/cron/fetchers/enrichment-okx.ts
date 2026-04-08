/**
 * OKX enrichment: equity curve, position history, current positions, stats detail
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'

// ============================================
// OKX Current Positions (open positions)
// ============================================

interface OkxSubPositionResponse {
  code: string
  data?: Array<{
    instId?: string
    posSide?: string
    openAvgPx?: string
    openTime?: string
    margin?: string
    subPos?: string
    mgnMode?: string
    upl?: string
    uplRatio?: string
  }>
}

export async function fetchOkxCurrentPositions(
  traderId: string
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchJson<OkxSubPositionResponse>(
      `https://www.okx.com/api/v5/copytrading/public-current-subpositions?instType=SWAP&uniqueCode=${traderId}&limit=50`,
      { timeoutMs: 30000 }
    )

    if (data.code !== '0' || !data.data?.length) return []

    return data.data.map((p) => ({
      symbol: (p.instId || '').replace('-SWAP', '').replace('-', ''),
      direction: (p.posSide || '').toLowerCase().includes('short') ? 'short' as const : 'long' as const,
      positionType: 'perpetual',
      marginMode: p.mgnMode?.toLowerCase() || 'cross',
      openTime: p.openTime ? new Date(Number(p.openTime)).toISOString() : null,
      closeTime: null,
      entryPrice: p.openAvgPx != null ? Number(p.openAvgPx) : null,
      exitPrice: null,
      maxPositionSize: p.subPos != null ? Number(p.subPos) : null,
      closedSize: null,
      pnlUsd: p.upl != null ? Number(p.upl) : null,
      pnlPct: p.uplRatio != null ? Number(p.uplRatio) * 100 : null,
      status: 'open',
    }))
  } catch (err) {
    logger.warn(`[enrichment] OKX current positions failed: ${err}`)
    return []
  }
}

// ============================================
// OKX Equity Curve (from weekly PnL API)
// ============================================

interface OkxWeeklyPnlResponse {
  code: string
  data?: Array<{
    beginTs?: string
    pnl?: string
    pnlRatio?: string
  }>
}

export async function fetchOkxEquityCurve(
  traderId: string,
  _days = 90
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchJson<OkxWeeklyPnlResponse>(
      `https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SWAP&uniqueCode=${traderId}`,
      { timeoutMs: 30000 }
    )

    if (data.code !== '0' || !data.data?.length) return []

    const sorted = [...data.data].sort((a, b) =>
      Number(a.beginTs || 0) - Number(b.beginTs || 0)
    )

    let cumulativeRoi = 0
    let cumulativePnl = 0

    return sorted.map((d) => {
      const weekPnlRatio = d.pnlRatio ? Number(d.pnlRatio) * 100 : 0
      const weekPnl = d.pnl ? Number(d.pnl) : 0
      cumulativeRoi += weekPnlRatio
      cumulativePnl += weekPnl

      const ts = d.beginTs ? Number(d.beginTs) : 0
      const date = ts > 0 ? new Date(ts).toISOString().split('T')[0] : ''

      return {
        date,
        roi: cumulativeRoi,
        pnl: cumulativePnl,
      }
    }).filter((p) => p.date)
  } catch (err) {
    logger.warn(`[enrichment] OKX equity curve failed: ${err}`)
    return []
  }
}

// ============================================
// OKX Position History
// ============================================

export async function fetchOkxPositionHistory(
  traderId: string,
  limit = 50
): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchJson<{
      code: string
      data?: Array<{
        instId?: string
        posSide?: string
        openAvgPx?: string
        closeAvgPx?: string
        openTime?: string
        closeTime?: string
        subPos?: string
        closeTotalPos?: string
        mgnMode?: string
        pnl?: string
        pnlRatio?: string
        lever?: string
      }>
    }>(
      `https://www.okx.com/priapi/v5/ecotrade/public/position-history?uniqueName=${traderId}&limit=${limit}`,
      { timeoutMs: 30000 }
    )

    if (data.code !== '0' || !data.data?.length) return []

    return data.data.map((p) => ({
      symbol: (p.instId || '').replace('-SWAP', '').replace('-', ''),
      direction: (p.posSide || '').toLowerCase().includes('short') ? 'short' as const : 'long' as const,
      positionType: 'perpetual',
      marginMode: p.mgnMode?.toLowerCase() || 'cross',
      openTime: p.openTime ? new Date(Number(p.openTime)).toISOString() : null,
      closeTime: p.closeTime ? new Date(Number(p.closeTime)).toISOString() : null,
      entryPrice: p.openAvgPx != null ? Number(p.openAvgPx) : null,
      exitPrice: p.closeAvgPx != null ? Number(p.closeAvgPx) : null,
      maxPositionSize: p.subPos != null ? Number(p.subPos) : null,
      closedSize: p.closeTotalPos != null ? Number(p.closeTotalPos) : null,
      pnlUsd: p.pnl != null ? Number(p.pnl) : null,
      pnlPct: p.pnlRatio != null ? Number(p.pnlRatio) * 100 : null,
      status: 'closed',
    }))
  } catch (err) {
    logger.warn(`[enrichment] OKX position history failed: ${err}`)
    return []
  }
}

// ============================================
// OKX Stats Detail
// ============================================

interface OkxTraderDetailResponse {
  code: string
  data?: Array<{
    uniqueCode?: string
    nickName?: string
    pnlRatio?: string
    pnl?: string
    winRatio?: string
    copyTraderNum?: string
    mdd?: string
    sharpeRatio?: string
    avgProfitRatio?: string
    avgLossRatio?: string
    maxProfit?: string
    maxLoss?: string
    tradeCount?: string
    avgHoldingTime?: string
  }>
}

export async function fetchOkxStatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchJson<OkxTraderDetailResponse>(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${traderId}`,
      {
        headers: { Accept: '*/*', 'Accept-Language': 'en-US,en;q=0.9' },
        timeoutMs: 30000,
      }
    )

    if (data.code !== '0' || !data.data?.length) return null

    const d = data.data[0]
    const parseNum = (v: string | undefined): number | null => {
      if (v == null) return null
      const n = parseFloat(v)
      return isNaN(n) ? null : n
    }

    const winRate = parseNum(d.winRatio)

    return {
      totalTrades: d.tradeCount ? parseInt(d.tradeCount) : null,
      profitableTradesPct: winRate != null ? winRate * 100 : null,
      avgHoldingTimeHours: d.avgHoldingTime ? parseFloat(d.avgHoldingTime) / 3600 : null,
      avgProfit: parseNum(d.avgProfitRatio),
      avgLoss: parseNum(d.avgLossRatio),
      largestWin: parseNum(d.maxProfit),
      largestLoss: parseNum(d.maxLoss),
      sharpeRatio: parseNum(d.sharpeRatio),
      maxDrawdown: parseNum(d.mdd),
      currentDrawdown: null,
      volatility: null,
      copiersCount: d.copyTraderNum ? parseInt(d.copyTraderNum) : null,
      copiersPnl: null,
      aum: null,
      winningPositions: null,
      totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] OKX stats detail failed: ${err}`)
    return null
  }
}

export function convertOkxPnlRatiosToEquityCurve(
  pnlRatios: Array<{ date: string; ratio: number }> | undefined
): EquityCurvePoint[] {
  if (!pnlRatios || pnlRatios.length === 0) return []

  return pnlRatios.map((p) => ({
    date: p.date,
    roi: p.ratio * 100,
    pnl: null,
  }))
}
