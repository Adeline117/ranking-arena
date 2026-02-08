/**
 * MEXC Futures — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_mexc.mjs (589 lines, puppeteer + API interception)
 *
 * MEXC copy trading page: https://www.mexc.com/futures/copyTrade/home
 *
 * [WARN] CDN-BLOCKED: API behind Akamai CDN, returns empty from US IPs.
 * Endpoints: contract.mexc.com/api/v1/private/copyTrade/traderRank/list (primary)
 * May work from Vercel datacenter IPs — needs testing on deployment.
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
  normalizeWinRate,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'

const SOURCE = 'mexc'
const TARGET = 500
const PAGE_SIZE = 50

const HEADERS: Record<string, string> = {
  Referer: 'https://www.mexc.com/futures/copyTrade/home',
  Origin: 'https://www.mexc.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

/* ---------- response shapes ---------- */

interface MexcTrader {
  traderId?: string | number
  uid?: string | number
  id?: string | number
  userId?: string | number
  nickName?: string
  nickname?: string
  name?: string
  displayName?: string
  traderName?: string
  avatar?: string
  avatarUrl?: string
  headImg?: string
  roi?: number | string
  totalRoi?: number | string
  pnlRate?: number | string
  pnl?: number | string
  totalPnl?: number | string
  profit?: number | string
  winRate?: number | string
  mdd?: number | string
  maxDrawdown?: number | string
  followerCount?: number | string
  copierCount?: number | string
  followers?: number | string
}

interface MexcApiResponse {
  success?: boolean
  code?: number
  data?: {
    list?: MexcTrader[]
    items?: MexcTrader[]
    traders?: MexcTrader[]
    rows?: MexcTrader[]
    totalPage?: number
    totalCount?: number
  } | MexcTrader[]
}

/* ---------- parser ---------- */

function extractList(data: MexcApiResponse): MexcTrader[] {
  if (!data?.data) return []
  if (Array.isArray(data.data)) return data.data
  return data.data.list || data.data.items || data.data.traders || data.data.rows || []
}

function parseTrader(item: MexcTrader, period: string): TraderData | null {
  const id = String(item.traderId || item.uid || item.id || item.userId || '')
  if (!id) return null

  const nickname = item.nickName || item.nickname || item.name || item.displayName || item.traderName
  if (!nickname || nickname.includes('*****') || nickname.startsWith('Trader_') || nickname.startsWith('Mexctrader-')) {
    return null
  }

  let roi = parseNum(item.roi ?? item.totalRoi ?? item.pnlRate)
  if (roi === null || roi === 0) return null
  // If ROI is in decimal form (0.5432 = 54.32%), convert to percentage
  if (Math.abs(roi) < 10) roi *= 100

  const pnl = parseNum(item.pnl ?? item.totalPnl ?? item.profit)

  let winRate = parseNum(item.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.mdd ?? item.maxDrawdown)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followerCount ?? item.copierCount ?? item.followers)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: nickname,
    profile_url: `https://www.mexc.com/futures/copyTrade/detail/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
      avatar_url: item.avatar || item.avatarUrl || item.headImg || null,
  }
}

/* ---------- fetching ---------- */

const API_ENDPOINTS = [
  // Primary — traderRank endpoint with rankType
  (page: number) =>
    `https://contract.mexc.com/api/v1/private/copyTrade/traderRank/list?pageNo=${page}&pageSize=${PAGE_SIZE}&rankType=1`,
  // Fallback — trader list
  (page: number) =>
    `https://contract.mexc.com/api/v1/private/copyTrade/trader/list?pageNo=${page}&pageSize=${PAGE_SIZE}&rankType=1`,
  // Fallback 2 — pageTrader
  (page: number) =>
    `https://contract.mexc.com/api/v1/private/copyTrade/pageTrader?pageNo=${page}&pageSize=${PAGE_SIZE}`,
]

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, MexcTrader>()
  let lastError = ''

  for (const makeUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    const maxPages = Math.ceil(TARGET / PAGE_SIZE)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = makeUrl(page)
        const data = await fetchJson<MexcApiResponse>(url, { headers: HEADERS })

        const list = extractList(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.traderId || item.uid || item.id || item.userId || '')
          if (id && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
        }

        if (list.length < PAGE_SIZE || allTraders.size >= TARGET) break
        await sleep(500)
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        break
      }
    }

    if (allTraders.size > 0) break // found data from this endpoint, no need to try fallbacks
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data from MEXC API (may be Akamai-blocked)' }
  }

  const traders: TraderData[] = []
  for (const [, item] of Array.from(allTraders)) {
    const t = parseTrader(item, period)
    if (t) traders.push(t)
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

  return { total: top.length, saved, error: error || lastError || undefined }
}

export async function fetchMexc(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    result.periods[period] = await fetchPeriod(supabase, period)
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  result.duration = Date.now() - start
  return result
}
