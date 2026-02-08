/**
 * OKX Web3 Copy Trade Leaderboard — Inline fetcher for Vercel serverless
 *
 * Source page: https://web3.okx.com/copy-trade/leaderboard
 *
 * The OKX Web3 leaderboard API was discovered via JS bundle analysis:
 *  - /priapi/v1/dx/strategy/copyTrade/getFilteredList  (requires auth)
 *  - /priapi/v1/dx/strategy/copyTrade/getCopyTradeList  (requires auth)
 *
 * Since these endpoints require wallet authentication, we fall back to the
 * OKX public copy-trading API v5 as a data source, which provides all traders
 * across CEX/Web3. The Web3 leaderboard on the page is ultimately populated
 * from OKX's broader copy-trading infrastructure.
 *
 * API: https://www.okx.com/api/v5/copytrading/public-lead-traders?instType=MARGIN
 *
 * Field mappings based on original import_okx_web3.mjs:
 *  - traderId: address / uniqueCode
 *  - roi: pnlRatio (decimal → *100) or from pnlRatios daily series
 *  - pnl: pnl
 *  - winRate: winRatio (decimal → *100)
 *  - followers: copyTraderNum
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
  parseNum,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'

const SOURCE = 'okx_web3'
const TARGET = 500
const DELAY_MS = 500

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// We try the public OKX v5 API with instType=MARGIN for web3-style traders
const API_URL = 'https://www.okx.com/api/v5/copytrading/public-lead-traders'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OkxTrader {
  uniqueCode?: string
  nickName?: string
  portLink?: string
  pnlRatio?: string | number
  pnl?: string | number
  winRatio?: string | number
  copyTraderNum?: string | number
  pnlRatios?: Array<{ beginTs: string; pnlRatio: string }>
}

interface OkxApiResponse {
  code?: string
  msg?: string
  data?: Array<{
    totalPage?: number | string
    ranks?: OkxTrader[]
  }>
}

// ---------------------------------------------------------------------------
// Period metrics from pnlRatios
// ---------------------------------------------------------------------------

function computePeriodMetrics(
  pnlRatios: Array<{ beginTs: string; pnlRatio: string }>,
  period: string
): { roi: number | null; maxDrawdown: number | null } {
  if (!Array.isArray(pnlRatios) || pnlRatios.length < 2) {
    return { roi: null, maxDrawdown: null }
  }

  const sorted = [...pnlRatios].sort(
    (a, b) => parseInt(a.beginTs) - parseInt(b.beginTs)
  )
  const days = WINDOW_DAYS[period] || 90
  const relevant = sorted.slice(-days)
  if (relevant.length < 2) return { roi: null, maxDrawdown: null }

  const first = parseFloat(relevant[0].pnlRatio)
  const last = parseFloat(relevant[relevant.length - 1].pnlRatio)
  const roi = ((1 + last) / (1 + first) - 1) * 100

  // MDD
  const equity = relevant.map((r) => 1 + parseFloat(r.pnlRatio))
  let peak = equity[0]
  let maxDD = 0
  for (const eq of equity) {
    if (eq > peak) peak = eq
    if (peak > 0) {
      const dd = ((peak - eq) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }

  return {
    roi: isFinite(roi) ? roi : null,
    maxDrawdown: maxDD > 0 && maxDD < 100 ? maxDD : null,
  }
}

// ---------------------------------------------------------------------------
// Leaderboard fetch
// ---------------------------------------------------------------------------

async function fetchLeaderboard(_period: string): Promise<OkxTrader[]> {
  const allTraders: OkxTrader[] = []
  let totalPages = 1

  // Try instType MARGIN first (web3-oriented), fall back to SWAP
  for (const instType of ['MARGIN', 'SWAP']) {
    allTraders.length = 0
    totalPages = 1

    for (let page = 1; page <= Math.min(totalPages, 50); page++) {
      try {
        const url = `${API_URL}?instType=${instType}&page=${page}`
        const json = await fetchJson<OkxApiResponse>(url)

        if (json.code !== '0' || !json.data?.length) break

        const item = json.data[0]
        totalPages = parseInt(String(item.totalPage)) || totalPages
        const ranks = item.ranks || []
        if (ranks.length === 0) break

        for (const t of ranks) {
          if (t.uniqueCode) allTraders.push(t)
        }

        if (allTraders.length >= TARGET) break
        await sleep(DELAY_MS)
      } catch {
        break
      }
    }

    // If we got data, stop trying other instTypes
    if (allTraders.length > 0) break
  }

  return allTraders
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const raw = await fetchLeaderboard(period)

  if (raw.length === 0) {
    return { total: 0, saved: 0, error: 'no data from API' }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const t of raw) {
    const id = t.uniqueCode || ''
    if (!id) continue

    const totalRoi = parseNum(t.pnlRatio) != null ? parseNum(t.pnlRatio)! * 100 : null
    const totalPnl = parseNum(t.pnl)
    const winRate =
      t.winRatio != null ? parseFloat(String(t.winRatio)) * 100 : null
    const followers = parseInt(String(t.copyTraderNum || '0'), 10) || null

    // Compute period-specific ROI + MDD from daily pnlRatios
    const metrics = computePeriodMetrics(t.pnlRatios || [], period)
    const roi = metrics.roi ?? totalRoi
    if (roi == null) continue

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: t.nickName || 'Unknown',
      profile_url: `https://web3.okx.com/copy-trade/account/${id}`,
      season_id: period,
      roi,
      pnl: totalPnl,
      win_rate: winRate,
      max_drawdown: metrics.maxDrawdown,
      followers,
      arena_score: calculateArenaScore(
        roi,
        totalPnl,
        metrics.maxDrawdown,
        winRate,
        period
      ),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    console.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
    let statsSaved = 0
    for (const trader of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: null,
        profitableTradesPct: trader.win_rate ?? null,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: trader.max_drawdown ?? null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: trader.followers ?? null,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    console.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function fetchOkxWeb3(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    result.periods[period] = await fetchPeriod(supabase, period)
    if (periods.indexOf(period) < periods.length - 1) await sleep(2000)
  }

  result.duration = Date.now() - start
  return result
}
