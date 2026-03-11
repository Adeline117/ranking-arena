/**
 * BloFin — Inline fetcher for Vercel serverless
 * Original: scripts/import/import_blofin.mjs (316 lines, puppeteer + API interception)
 *
 * BloFin copy trading page: https://blofin.com/en/copy-trade
 *
 * [WARN] AUTH REQUIRED: openapi.blofin.com returns 401 Unauthorized.
 * Website API (www.blofin.com) is behind Cloudflare.
 * Original script uses Puppeteer to browse the page and intercept internal API calls.
 * Needs browser/proxy infrastructure or API authentication to work.
 *
 * BloFin period mapping: '7D' → range '1', '30D' → range '2', '90D' → range '3'
 *
 * The browser intercepted API responses with 'copy', 'trader', 'lead', 'rank', 'blofin' in URL.
 * Fields discovered: uniqueName, traderId, nickName, avatar, portraitLink, roi, returnRate,
 *   pnlRatio, pnl, winRate, maxDrawdown, followers, copyTraderNum.
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
  normalizeROI,
  getWinRateFormat,
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'
// Dynamic import to avoid bundling puppeteer on Vercel
const getInterceptApiResponses = () => import('../scrapers/cloudflare-bypass').then(m => m.interceptApiResponses)

const SOURCE = 'blofin'
const TARGET = 500
const PAGE_SIZE = 50

const HEADERS: Record<string, string> = {
  Referer: 'https://blofin.com/en/copy-trade',
  Origin: 'https://blofin.com',
  Accept: 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
}

const PERIOD_RANGE: Record<string, string> = { '7D': '1', '30D': '2', '90D': '3' }
/** Period values for the public/leaderboard endpoint (days) */
const PERIOD_DAYS: Record<string, string> = { '7D': '7', '30D': '30', '90D': '90' }

const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

/* ---------- response shapes ---------- */

interface BlofinTrader {
  uniqueName?: string
  traderId?: string | number
  uid?: string | number
  id?: string | number
  nickName?: string
  nickname?: string
  name?: string
  avatar?: string
  avatarUrl?: string
  portraitLink?: string
  roi?: number | string
  returnRate?: number | string
  pnlRatio?: number | string
  pnl?: number | string
  profit?: number | string
  totalPnl?: number | string
  winRate?: number | string
  maxDrawdown?: number | string
  mdd?: number | string
  followers?: number | string
  followerCount?: number | string
  copyTraderNum?: number | string
}

interface BlofinApiResponse {
  code?: string | number
  msg?: string
  data?: {
    list?: BlofinTrader[]
    records?: BlofinTrader[]
    items?: BlofinTrader[]
    total?: number | string
  } | BlofinTrader[]
}

/* ---------- parser ---------- */

function extractList(data: BlofinApiResponse): BlofinTrader[] {
  if (!data?.data) return []
  if (Array.isArray(data.data)) return data.data
  return data.data.list || data.data.records || data.data.items || []
}

function parseTrader(item: BlofinTrader, period: string): TraderData | null {
  const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
  if (!id) return null

  const nickname = item.nickName || item.nickname || item.name || item.uniqueName
  if (!nickname || nickname.startsWith('Trader_')) return null

  let roi = parseNum(item.roi ?? item.returnRate ?? item.pnlRatio)
  if (roi === null || roi === 0) return null
  roi = normalizeROI(roi, SOURCE) ?? roi

  const pnl = parseNum(item.pnl ?? item.profit ?? item.totalPnl)

  let winRate = parseNum(item.winRate)
  winRate = normalizeWinRate(winRate, getWinRateFormat(SOURCE))

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)
  if (maxDrawdown !== null) {
    maxDrawdown = Math.abs(maxDrawdown)
    if (maxDrawdown > 0 && maxDrawdown <= 1) maxDrawdown *= 100
  }

  const followers = parseNum(item.followers ?? item.followerCount ?? item.copyTraderNum)

  return {
    source: SOURCE,
    source_trader_id: id,
    handle: nickname,
    profile_url: `https://blofin.com/en/copy-trade/trader/${id}`,
    season_id: period,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
      avatar_url: item.avatar || item.avatarUrl || item.portraitLink || null,
  }
}

/* ---------- fetching ---------- */

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodDays = PERIOD_DAYS[period] || '30'
  const allTraders = new Map<string, BlofinTrader>()
  let lastError = ''

  // Strategy 0: VPS Playwright scraper (most reliable for BloFin)
  const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
  const VPS_SCRAPER_KEY = process.env.VPS_SCRAPER_KEY || process.env.VPS_PROXY_KEY || ''
  if (VPS_SCRAPER_KEY) {
    try {
      const url = `${VPS_SCRAPER_URL}/blofin/leaderboard?period=${periodDays}&limit=${TARGET}`
      const res = await fetch(url, {
        headers: { 'X-Proxy-Key': VPS_SCRAPER_KEY },
        signal: AbortSignal.timeout(60_000),
      })
      if (res.ok) {
        const data = (await res.json()) as BlofinApiResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
          if (id && !allTraders.has(id)) allTraders.set(id, item)
        }
        if (allTraders.size > 0) {
          logger.info(`[${SOURCE}] VPS scraper got ${allTraders.size} traders`)
        }
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Strategy 1: CF Worker proxy — routes through Cloudflare network to bypass blocks
  // The CF Worker has a dedicated /blofin/leaderboard endpoint that proxies to openapi.blofin.com
  try {
    const limit = Math.min(TARGET, 500) // BloFin may cap at 100-500
    const proxyUrl = `${PROXY_URL}/blofin/leaderboard?period=${periodDays}&limit=${limit}`
    const data = await fetchJson<BlofinApiResponse>(proxyUrl, {
      headers: HEADERS,
      timeoutMs: 20_000,
    })

    // Check for proxy error
    if ((data as unknown as { error?: string }).error) {
      lastError = `CF proxy error: ${(data as unknown as { error: string }).error}`
    } else if (data?.code === '401' || data?.code === 401) {
      lastError = 'BloFin API requires authentication (401) via CF proxy'
    } else {
      const list = extractList(data)
      for (const item of list) {
        const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
        if (id && !allTraders.has(id)) {
          allTraders.set(id, item)
        }
      }
      if (allTraders.size > 0) {
        logger.info(`[${SOURCE}] CF Worker proxy got ${allTraders.size} traders`)
      }
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    logger.warn(`[${SOURCE}] CF Worker proxy failed: ${lastError}`)
  }

  // Strategy 2: Direct openapi.blofin.com — the correct public endpoint
  if (allTraders.size === 0) {
    const directEndpoints = [
      `https://openapi.blofin.com/api/v1/copytrading/public/leaderboard?period=${periodDays}&limit=${TARGET}`,
      `https://openapi.blofin.com/api/v1/copytrading/public/leaderboard?period=${periodDays}&limit=100`,
    ]

    for (const url of directEndpoints) {
      if (allTraders.size > 0) break
      try {
        const data = await fetchJson<BlofinApiResponse>(url, { headers: HEADERS })

        if (data?.code === '401' || data?.code === 401) {
          lastError = 'BloFin API requires authentication (401)'
          break
        }

        const list = extractList(data)
        for (const item of list) {
          const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
          if (id && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
        }

        if (allTraders.size > 0) {
          logger.info(`[${SOURCE}] Direct API got ${allTraders.size} traders`)
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        logger.warn(`[${SOURCE}] Direct API failed: ${lastError}`)
      }
    }
  }

  // Strategy 3: VPS proxy fallback for geo/WAF blocks
  if (allTraders.size === 0) {
    const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_SG
    if (vpsUrl) {
      logger.warn(`[${SOURCE}] Trying VPS proxy...`)
      try {
        const targetUrl = `https://openapi.blofin.com/api/v1/copytrading/public/leaderboard?period=${periodDays}&limit=${TARGET}`
        const res = await fetch(vpsUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
          },
          body: JSON.stringify({
            url: targetUrl,
            method: 'GET',
            headers: HEADERS,
          }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          const data = (await res.json()) as BlofinApiResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
            if (id && !allTraders.has(id)) allTraders.set(id, item)
          }
          if (allTraders.size > 0) {
            logger.info(`[${SOURCE}] VPS proxy got ${allTraders.size} traders`)
          }
        }
      } catch (err) {
        logger.warn(`[${SOURCE}] VPS proxy failed: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }

  // Strategy 4: Stealth browser fallback when all HTTP methods fail
  if (allTraders.size === 0) {
    logger.warn(`[${SOURCE}] All HTTP methods failed, trying stealth browser fallback...`)
    try {
      const interceptApiResponses = await getInterceptApiResponses()
      const { responses } = await interceptApiResponses(
        'https://blofin.com/en/copy-trade',
        ['copy', 'trader', 'lead', 'rank', 'blofin'],
        { proxy: process.env.STEALTH_PROXY || undefined, maxWaitMs: 20_000 }
      )
      for (const resp of responses) {
        try {
          const data = JSON.parse(resp.body) as BlofinApiResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.uniqueName || item.traderId || item.uid || item.id || '')
            if (id && !allTraders.has(id)) allTraders.set(id, item)
          }
        } catch { /* skip unparseable */ }
      }
      if (allTraders.size > 0) {
        logger.warn(`[${SOURCE}] Stealth browser got ${allTraders.size} traders`)
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] Stealth browser fallback failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data from BloFin API (auth required or CF blocked)' }
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
    logger.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
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
    logger.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error: error || lastError || undefined }
}

export async function fetchBlofin(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  try {
    for (const period of periods) {
      result.periods[period] = await fetchPeriod(supabase, period)
      if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  result.duration = Date.now() - start
  return result
}
