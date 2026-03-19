/**
 * OKX Spot enrichment — reuses OKX futures logic with instType=SPOT
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, PositionHistoryItem, StatsDetail } from './enrichment-types'

export async function fetchOkxSpotEquityCurve(
  traderId: string,
  _days = 90
): Promise<EquityCurvePoint[]> {
  try {
    const data = await fetchJson<{
      code: string
      data?: Array<{ beginTs?: string; pnl?: string; pnlRatio?: string }>
    }>(
      `https://www.okx.com/api/v5/copytrading/public-weekly-pnl?instType=SPOT&uniqueCode=${encodeURIComponent(traderId)}`,
      { timeoutMs: 15000 }
    )
    if (data.code !== '0' || !data.data?.length) return []

    const sorted = [...data.data].sort((a, b) => Number(a.beginTs || 0) - Number(b.beginTs || 0))
    let cumulativeRoi = 0
    let cumulativePnl = 0

    return sorted.map((d) => {
      cumulativeRoi += d.pnlRatio ? Number(d.pnlRatio) * 100 : 0
      cumulativePnl += d.pnl ? Number(d.pnl) : 0
      const ts = d.beginTs ? Number(d.beginTs) : 0
      return { date: ts > 0 ? new Date(ts).toISOString().split('T')[0] : '', roi: cumulativeRoi, pnl: cumulativePnl }
    }).filter((p) => p.date)
  } catch (err) {
    logger.warn(`[enrichment] OKX Spot equity curve failed: ${err}`)
    return []
  }
}

export async function fetchOkxSpotStatsDetail(traderId: string): Promise<StatsDetail | null> {
  try {
    const data = await fetchJson<{
      code: string
      data?: Array<{
        uniqueCode?: string; pnlRatio?: string; pnl?: string; winRatio?: string
        copyTraderNum?: string; mdd?: string; sharpeRatio?: string
        avgProfitRatio?: string; avgLossRatio?: string; maxProfit?: string; maxLoss?: string
        tradeCount?: string; avgHoldingTime?: string; aum?: string
      }>
    }>(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SPOT&uniqueCode=${encodeURIComponent(traderId)}`,
      { headers: { Accept: '*/*' }, timeoutMs: 15000 }
    )
    if (data.code !== '0' || !data.data?.length) return null

    const d = data.data[0]
    const n = (v: string | undefined): number | null => { if (v == null) return null; const x = parseFloat(v); return isNaN(x) ? null : x }
    const winRate = n(d.winRatio)

    return {
      totalTrades: d.tradeCount ? parseInt(d.tradeCount) : null,
      profitableTradesPct: winRate != null ? winRate * 100 : null,
      avgHoldingTimeHours: d.avgHoldingTime ? parseFloat(d.avgHoldingTime) / 3600 : null,
      avgProfit: n(d.avgProfitRatio), avgLoss: n(d.avgLossRatio),
      largestWin: n(d.maxProfit), largestLoss: n(d.maxLoss),
      sharpeRatio: n(d.sharpeRatio), maxDrawdown: n(d.mdd),
      currentDrawdown: null, volatility: null,
      copiersCount: d.copyTraderNum ? parseInt(d.copyTraderNum) : null,
      copiersPnl: null, aum: n(d.aum),
      winningPositions: null, totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] OKX Spot stats detail failed: ${err}`)
    return null
  }
}

export async function fetchOkxSpotCurrentPositions(traderId: string): Promise<PositionHistoryItem[]> {
  try {
    const data = await fetchJson<{
      code: string
      data?: Array<{
        instId?: string; posSide?: string; openAvgPx?: string; openTime?: string
        subPos?: string; mgnMode?: string; upl?: string; uplRatio?: string
      }>
    }>(
      `https://www.okx.com/api/v5/copytrading/public-current-subpositions?instType=SPOT&uniqueCode=${encodeURIComponent(traderId)}&limit=50`,
      { timeoutMs: 15000 }
    )
    if (data.code !== '0' || !data.data?.length) return []

    return data.data.map((p) => ({
      symbol: (p.instId || '').replace('-SPOT', '').replace('-', ''),
      direction: 'long' as const, // Spot is always long
      positionType: 'spot',
      marginMode: 'cash',
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
    logger.warn(`[enrichment] OKX Spot current positions failed: ${err}`)
    return []
  }
}
