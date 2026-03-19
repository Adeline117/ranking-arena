/**
 * OKX Web3 enrichment — equity curve from pnlRatios in leaderboard response
 *
 * OKX Web3 returns cumulative daily pnlRatios in the leaderboard API.
 * We re-fetch the leaderboard for the specific trader and extract the curve.
 */

import { fetchJson } from './shared'
import { logger } from '@/lib/logger'
import type { EquityCurvePoint, StatsDetail } from './enrichment-types'

interface OkxLeaderboardEntry {
  uniqueCode: string
  pnlRatios?: Array<{ ts: string; ratio: string }>
  pnl?: string
  pnlRatio?: string
  winRatio?: string
  copyTraderNum?: string
  aum?: string
}

interface OkxResponse {
  code: string
  data?: Array<{ ranks?: OkxLeaderboardEntry[] }>
}

export async function fetchOkxWeb3EquityCurve(
  traderId: string,
  _days = 90
): Promise<EquityCurvePoint[]> {
  try {
    // OKX embeds pnlRatios in the leaderboard response — fetch with uniqueCode filter
    const data = await fetchJson<OkxResponse>(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${encodeURIComponent(traderId)}&limit=1`,
      { timeoutMs: 15000 }
    )

    if (data.code !== '0' || !data.data?.length) return []
    const ranks = data.data[0]?.ranks || []
    const trader = ranks.find(r => r.uniqueCode === traderId)
    if (!trader?.pnlRatios?.length) return []

    // pnlRatios is cumulative from inception
    return trader.pnlRatios
      .sort((a, b) => Number(a.ts) - Number(b.ts))
      .map(p => ({
        date: new Date(Number(p.ts)).toISOString().split('T')[0],
        roi: Number(p.ratio) * 100,
        pnl: null,
      }))
      .filter(p => p.date)
  } catch (err) {
    logger.warn(`[enrichment] OKX Web3 equity curve failed: ${err}`)
    return []
  }
}

export async function fetchOkxWeb3StatsDetail(
  traderId: string
): Promise<StatsDetail | null> {
  try {
    const data = await fetchJson<OkxResponse>(
      `https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=SWAP&uniqueCode=${encodeURIComponent(traderId)}&limit=1`,
      { timeoutMs: 15000 }
    )

    if (data.code !== '0' || !data.data?.length) return null
    const ranks = data.data[0]?.ranks || []
    const d = ranks.find(r => r.uniqueCode === traderId)
    if (!d) return null

    const n = (v: string | undefined): number | null => {
      if (v == null) return null
      const x = parseFloat(v)
      return isNaN(x) ? null : x
    }
    const winRate = n(d.winRatio)

    return {
      totalTrades: null,
      profitableTradesPct: winRate != null ? winRate * 100 : null,
      avgHoldingTimeHours: null,
      avgProfit: null, avgLoss: null,
      largestWin: null, largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: null,
      currentDrawdown: null, volatility: null,
      copiersCount: d.copyTraderNum ? parseInt(d.copyTraderNum) : null,
      copiersPnl: null, aum: n(d.aum),
      winningPositions: null, totalPositions: null,
    }
  } catch (err) {
    logger.warn(`[enrichment] OKX Web3 stats detail failed: ${err}`)
    return null
  }
}
