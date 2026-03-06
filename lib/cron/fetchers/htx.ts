/**
 * HTX Futures — Inline fetcher for Vercel serverless
 * API: https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchWithVpsFallback,
  sleep,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'htx_futures'
const API_URL = 'https://futures.htx.com/-/x/hbg/v1/futures/copytrading/rank'
const TARGET = 500
const PAGE_SIZE = 50

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

interface HtxTrader {
  userSign?: string
  uid?: number
  nickName?: string
  imgUrl?: string
  copyUserNum?: number
  fullUserNum?: number
  winRate?: number
  profitRate90?: number
  profit90?: number
  copyProfit?: number
  mdd?: number
  aum?: string | number
  profitList?: number[]
  tradeDays?: number
}

function calcPeriodRoi(profitList: number[], period: string): number | null {
  if (!Array.isArray(profitList) || profitList.length < 2) return null
  const days = WINDOW_DAYS[period] || 30
  const last = profitList[profitList.length - 1]
  if (profitList.length >= days) {
    const startIdx = profitList.length - days
    const startVal = startIdx > 0 ? profitList[startIdx - 1] : 0
    return (last - startVal) * 100
  }
  return (last - profitList[0]) * 100
}

function calcMaxDrawdown(profitList: number[], period: string): number | null {
  if (!Array.isArray(profitList) || profitList.length < 2) return null
  const days = WINDOW_DAYS[period] || 30
  const relevant = profitList.slice(-days)
  if (relevant.length < 2) return null
  const equity = relevant.map((r) => 1 + r)
  let peak = equity[0]
  let maxDD = 0
  for (const e of equity) {
    if (e > peak) peak = e
    if (peak > 0) {
      const dd = ((peak - e) / peak) * 100
      if (dd > maxDD) maxDD = dd
    }
  }
  return maxDD > 0 && maxDD < 100 ? maxDD : null
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, HtxTrader>()
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${API_URL}?rankType=1&pageNo=${page}&pageSize=${PAGE_SIZE}`
      const data = await fetchWithVpsFallback<{ code: number; data?: { itemList?: HtxTrader[] } }>(url)

      if (data.code !== 200 || !data.data?.itemList) break
      const list = data.data.itemList
      if (list.length === 0) break

      for (const item of list) {
        const id = item.userSign || String(item.uid || '')
        if (!id || allTraders.has(id)) continue
        allTraders.set(id, item)
      }

      if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
      await sleep(500)
    } catch (err) {
      logger.warn(`[${SOURCE}] Page fetch failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const [id, item] of Array.from(allTraders)) {
    const profitList = item.profitList || []
    let roi: number | null
    let maxDrawdown: number | null

    if (period === '90D') {
      roi = item.profitRate90 != null ? Number(item.profitRate90) : null
      maxDrawdown = item.mdd != null ? Number(item.mdd) * 100 : null
    } else {
      roi = calcPeriodRoi(profitList as number[], period)
      maxDrawdown = calcMaxDrawdown(profitList as number[], period)
      if (roi === null) roi = item.profitRate90 != null ? Number(item.profitRate90) : null
      if (maxDrawdown === null && item.mdd != null) maxDrawdown = Number(item.mdd) * 100
    }

    if (roi === null || roi === 0) continue
    const winRate = item.winRate != null ? Number(item.winRate) * 100 : null

    const pnl = Number(item.profit90 || item.copyProfit || 0) || null
    const aumVal = item.aum != null ? Number(item.aum) : null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `HTX_${item.uid}`,
      profile_url: `https://futures.htx.com/en-us/copytrading/futures/detail/${id}`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: item.copyUserNum || null,
      aum: aumVal && aumVal > 0 ? aumVal : null,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
      avatar_url: item.imgUrl || null,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for all periods
  if (saved > 0) {
    logger.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders (${period})...`)
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
        aum: trader.aum ?? null,
        winningPositions: null,
        totalPositions: null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    logger.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error }
}

export async function fetchHtx(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      try {
        result.periods[period] = await fetchPeriod(supabase, period)
      } catch (err) {
        captureException(err instanceof Error ? err : new Error(String(err)), {
          tags: { platform: SOURCE, period },
        })
        logger.error(`[${SOURCE}] Period ${period} failed`, err instanceof Error ? err : new Error(String(err)))
        result.periods[period] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
      }
      if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
    }

    result.duration = Date.now() - start
    return result
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
    result.duration = Date.now() - start
    return result
  }
}
