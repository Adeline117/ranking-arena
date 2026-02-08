/**
 * Phemex — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_phemex.mjs (317 lines, Playwright + API interception)
 *
 * Phemex copy trading page: https://phemex.com/copy-trading
 *
 * [WARN] CLOUDFRONT-BLOCKED: All API endpoints return 403 (CloudFront geo-restriction).
 * Original script uses Playwright to browse the page and intercept internal API calls.
 * The browser intercepted API calls with 'copy', 'trader', 'leader', 'rank', 'copyTrad' in URL.
 * Phemex uses E8 scaling for PnL values (divide by 1e8).
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

const SOURCE = 'phemex'
const TARGET = 500
const PAGE_SIZE = 50

const HEADERS: Record<string, string> = {
  Referer: 'https://phemex.com/copy-trading',
  Origin: 'https://phemex.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

const PERIOD_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

/* ---------- response shapes ---------- */

interface PhemexTrader {
  uid?: string | number
  traderId?: string | number
  id?: string | number
  userId?: string | number
  user_id?: string | number
  nickname?: string
  traderName?: string
  nickName?: string
  name?: string
  displayName?: string
  avatar?: string
  headUrl?: string
  avatarUrl?: string
  roi?: number | string
  roiRate?: number | string
  profitRate?: number | string
  returnRate?: number | string
  pnlRatio?: number | string
  pnl?: number | string
  totalPnl?: number | string
  profit?: number | string
  winRate?: number | string
  maxDrawdown?: number | string
  mdd?: number | string
  followers?: number | string
  followerNum?: number | string
  copyNum?: number | string
  copierNum?: number | string
}

interface PhemexApiResponse {
  code?: number
  msg?: string
  data?: {
    rows?: PhemexTrader[]
    list?: PhemexTrader[]
    records?: PhemexTrader[]
    items?: PhemexTrader[]
    total?: number
  } | PhemexTrader[]
  result?: {
    traders?: PhemexTrader[]
    rows?: PhemexTrader[]
  }
}

/* ---------- parser ---------- */

function extractList(data: PhemexApiResponse): PhemexTrader[] {
  if (!data) return []

  // Check data.data
  if (data.data) {
    if (Array.isArray(data.data)) return data.data
    const d = data.data
    return d.rows || d.list || d.records || d.items || []
  }

  // Check data.result
  if (data.result) {
    return data.result.traders || data.result.rows || []
  }

  return []
}

function parseTrader(item: PhemexTrader, period: string): TraderData | null {
  const id = String(item.uid || item.traderId || item.id || item.userId || item.user_id || '')
  if (!id) return null

  const nickname = item.nickname || item.traderName || item.nickName || item.name || item.displayName
  if (!nickname || nickname.startsWith('Trader_')) return null

  let roi = parseNum(item.roi ?? item.roiRate ?? item.profitRate ?? item.returnRate ?? item.pnlRatio)
  if (roi === null || roi === 0) return null
  if (Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100

  // Phemex may use E8 scaling for PnL
  let pnl = parseNum(item.pnl ?? item.totalPnl ?? item.profit)
  if (pnl !== null && Math.abs(pnl) > 1e7) pnl = pnl / 1e8

  let winRate = parseNum(item.winRate)
  if (winRate !== null) {
    if (winRate > 0 && winRate <= 1) winRate *= 100
  }
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followers ?? item.followerNum ?? item.copyNum ?? item.copierNum)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: nickname,
    profile_url: `https://phemex.com/copy-trading/trader/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
      avatar_url: item.avatar || item.headUrl || item.avatarUrl || null,
  }
}

/* ---------- fetching ---------- */

// Phemex API endpoint candidates — behind CloudFront but may work from Vercel
const API_ENDPOINTS = [
  // Standard copy trading APIs
  (page: number, days: number) =>
    `https://phemex.com/api/phemex-user/users/children/queryTraderWithCopySetting?pageNo=${page}&pageSize=${PAGE_SIZE}&days=${days}`,
  (page: number, _days: number) =>
    `https://phemex.com/api/copy-trading/traders?pageNo=${page}&pageSize=${PAGE_SIZE}&sortBy=roi`,
  (page: number, _days: number) =>
    `https://phemex.com/api/copy-trading/ranking?pageNo=${page}&pageSize=${PAGE_SIZE}`,
  (page: number, _days: number) =>
    `https://phemex.com/api/copy-trading/trader/list?pageNo=${page}&pageSize=${PAGE_SIZE}`,
  // Alternative: Phemex REST API
  (page: number, _days: number) =>
    `https://api.phemex.com/api/copy-trading/traders?pageNo=${page}&pageSize=${PAGE_SIZE}`,
]

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const days = PERIOD_DAYS[period] || 30
  const allTraders = new Map<string, PhemexTrader>()
  let lastError = ''

  for (const makeUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    const maxPages = Math.ceil(TARGET / PAGE_SIZE)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = makeUrl(page, days)
        const data = await fetchJson<PhemexApiResponse>(url, { headers: HEADERS })

        const list = extractList(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.uid || item.traderId || item.id || item.userId || item.user_id || '')
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

    if (allTraders.size > 0) break
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data from Phemex API (CloudFront blocked)' }
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

export async function fetchPhemex(
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
