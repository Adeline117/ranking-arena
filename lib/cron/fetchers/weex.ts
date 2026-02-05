/**
 * Weex — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_weex.mjs (1100 lines — the largest! puppeteer + API interception + DOM)
 *
 * Weex copy trading page: https://www.weex.com/zh-CN/copy-trading
 *
 * ⚠️  BROWSER-ONLY: All API endpoints return "Page is Not Found" as of 2025.
 * The original script uses Puppeteer to browse the page and intercept internal API calls.
 * POST endpoints (/api/copyTrade/topTraderListView etc.) require browser session cookies.
 * Needs browser/proxy infrastructure to work.
 *
 * Weex period mapping (limited data windows):
 * - 30D ← Weex "3week" (21 days)
 * - 90D ← Weex "all" (full time)
 * - 7D  ← NOT supported by Weex
 *
 * Key fields: traderUserId, traderNickName, totalReturnRate (already percentage),
 *   threeWeeksPNL, headPic, followCount, ndaysReturnRates, threeWeekRoi
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

const SOURCE = 'weex'
const TARGET = 500
const PAGE_SIZE = 100

const HEADERS: Record<string, string> = {
  Referer: 'https://www.weex.com/zh-CN/copy-trading',
  Origin: 'https://www.weex.com',
  Accept: 'application/json',
  'Content-Type': 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
}

/* ---------- response shapes ---------- */

interface WeexTrader {
  traderUserId?: string | number
  traderId?: string | number
  uid?: string | number
  id?: string | number
  traderNickName?: string
  nickName?: string
  nickname?: string
  name?: string
  headPic?: string
  avatar?: string
  headUrl?: string
  // ROI — totalReturnRate is already percentage form (e.g. 113.24 = 113.24%)
  totalReturnRate?: number | string
  threeWeekRoi?: number | string
  nWeekRoi?: number | string
  weekRoi?: number | string
  totalRoi?: number | string
  roi?: number | string
  // PnL
  threeWeeksPNL?: number | string
  profit?: number | string
  totalProfit?: number | string
  // Stats
  winRate?: number | string
  maxDrawdown?: number | string
  followCount?: number | string
  followerCount?: number | string
  copierCount?: number | string
  // Nested data
  ndaysReturnRates?: Array<{ ndays: number | string; rate: number | string }>
  itemVoList?: Array<{ itemType?: string; key?: string; value?: string | number; label?: string }>
  profile?: {
    threeWeekRoi?: number | string
    nWeekRoi?: number | string
    profit?: number | string
    winRate?: number | string
    maxDrawdown?: number | string
  }
}

interface WeexSection {
  tab?: string
  desc?: string
  sortRule?: string
  list?: WeexTrader[]
  traders?: WeexTrader[]
}

interface WeexApiResponse {
  code?: number
  msg?: string
  data?:
    | WeexSection[]                                 // topTraderListView grouped format
    | { list?: WeexTrader[]; traders?: WeexTrader[] } // standard list format
    | WeexTrader[]                                   // direct array
}

/* ---------- parser ---------- */

function extractTradersFromResponse(data: WeexApiResponse): WeexTrader[] {
  if (!data?.data) return []

  // topTraderListView: { data: [{ tab, desc, list: [...] }] }
  if (Array.isArray(data.data)) {
    // Check if it's an array of sections (objects with list/traders) vs array of traders
    if (data.data.length > 0 && (data.data[0] as WeexSection).list) {
      const all: WeexTrader[] = []
      for (const section of data.data as WeexSection[]) {
        const sectionList = section.list || section.traders || []
        all.push(...sectionList)
      }
      return all
    }
    // Direct array of traders
    return data.data as WeexTrader[]
  }

  // Standard format: { data: { list: [...] } }
  const d = data.data as { list?: WeexTrader[]; traders?: WeexTrader[] }
  return d.list || d.traders || []
}

function parseTrader(item: WeexTrader, period: string): TraderData | null {
  const id = String(item.traderUserId || item.traderId || item.uid || item.id || '')
  if (!id) return null

  const nickname = item.traderNickName || item.nickName || item.nickname || item.name || ''
  if (!nickname) return null

  // Extract ROI — totalReturnRate is already in percentage form
  let roi = parseNum(item.totalReturnRate)

  // Fallback to other ROI fields
  if (roi === null || roi === 0) {
    roi = parseNum(item.threeWeekRoi ?? item.nWeekRoi ?? item.weekRoi ?? item.totalRoi ?? item.roi)
    // Small decimal values need conversion
    if (roi !== null && Math.abs(roi) > 0 && Math.abs(roi) < 1) roi *= 100
  }

  // Try ndaysReturnRates array
  if ((roi === null || roi === 0) && item.ndaysReturnRates?.length) {
    const rateObj = item.ndaysReturnRates.find(r => r.ndays === 21 || r.ndays === 'n21')
      || item.ndaysReturnRates.find(r => r.ndays === 30 || r.ndays === 'n30')
      || item.ndaysReturnRates[item.ndaysReturnRates.length - 1]
    if (rateObj?.rate != null) roi = parseNum(rateObj.rate)
  }

  // Try itemVoList
  if ((roi === null || roi === 0) && item.itemVoList?.length) {
    const roiItem = item.itemVoList.find(
      v => v.itemType === 'roi' || v.key === 'roi' || v.label?.includes('收益')
    )
    if (roiItem?.value != null) roi = parseNum(roiItem.value)
  }

  // Try nested profile
  if ((roi === null || roi === 0) && item.profile) {
    roi = parseNum(item.profile.threeWeekRoi ?? item.profile.nWeekRoi)
    if (roi !== null && Math.abs(roi) > 0 && Math.abs(roi) < 10) roi *= 100
  }

  if (roi === null || roi === 0) return null

  const pnl = parseNum(item.threeWeeksPNL ?? item.profit ?? item.totalProfit ?? item.profile?.profit)

  let winRate = parseNum(item.winRate ?? item.profile?.winRate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.profile?.maxDrawdown)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followCount ?? item.followerCount ?? item.copierCount)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: nickname,
    profile_url: `https://www.weex.com/zh-CN/copy-trading/trader/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
  }
}

/* ---------- fetching ---------- */

// Weex API endpoints — POST endpoints as discovered from original script
interface EndpointDef {
  url: string
  method: 'GET' | 'POST'
  body?: (page: number) => unknown
}

const API_ENDPOINTS: EndpointDef[] = [
  // topTraderListView — primary (returns grouped sections)
  {
    url: 'https://www.weex.com/api/copyTrade/topTraderListView',
    method: 'POST',
    body: (page: number) => ({ pageSize: PAGE_SIZE, pageNum: page }),
  },
  // traderList — standard list
  {
    url: 'https://www.weex.com/api/copyTrade/traderList',
    method: 'POST',
    body: (page: number) => ({ pageSize: PAGE_SIZE, pageNum: page }),
  },
  // copy/traders
  {
    url: 'https://www.weex.com/api/copy/traders',
    method: 'POST',
    body: (page: number) => ({ pageSize: PAGE_SIZE, pageNum: page }),
  },
  // Alternative domains
  {
    url: 'https://capi.weex.com/api/copyTrade/topTraderListView',
    method: 'POST',
    body: (page: number) => ({ pageSize: PAGE_SIZE, pageNum: page }),
  },
  // GET variant
  {
    url: 'https://www.weex.com/api/copyTrade/topTraderListView',
    method: 'GET',
  },
]

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const allTraders = new Map<string, WeexTrader>()
  let lastError = ''

  for (const endpoint of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break

    const maxPages = Math.ceil(TARGET / PAGE_SIZE)
    for (let page = 1; page <= maxPages; page++) {
      try {
        const opts: Parameters<typeof fetchJson>[1] = {
          method: endpoint.method,
          headers: HEADERS,
        }
        if (endpoint.method === 'POST' && endpoint.body) {
          opts.body = endpoint.body(page)
        }

        const url = endpoint.method === 'GET'
          ? `${endpoint.url}?pageSize=${PAGE_SIZE}&pageNum=${page}`
          : endpoint.url

        const data = await fetchJson<WeexApiResponse>(url, opts)

        const list = extractTradersFromResponse(data)
        if (list.length === 0) break

        for (const item of list) {
          const id = String(item.traderUserId || item.traderId || item.uid || item.id || '')
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
    return { total: 0, saved: 0, error: lastError || 'No data from Weex API (endpoints may have changed)' }
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
        profitableTradesPct: trader.win_rate,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: trader.max_drawdown,
        currentDrawdown: null,
        volatility: null,
        copiersCount: trader.followers,
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

export async function fetchWeex(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  // Weex only supports 30D and 90D (no 7D data)
  const supportedPeriods = periods.filter(p => p !== '7D')

  for (const period of supportedPeriods) {
    result.periods[period] = await fetchPeriod(supabase, period)
    if (supportedPeriods.indexOf(period) < supportedPeriods.length - 1) await sleep(1000)
  }

  // For 7D, return empty with note
  if (periods.includes('7D') && !result.periods['7D']) {
    result.periods['7D'] = { total: 0, saved: 0, error: 'Weex does not provide 7D data' }
  }

  result.duration = Date.now() - start
  return result
}
