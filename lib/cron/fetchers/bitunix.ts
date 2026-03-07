/**
 * Bitunix Futures — Inline fetcher for Vercel serverless
 *
 * Bitunix copy trading page: https://www.bitunix.com/copy-trading/square
 * API at api.bitunix.com is behind Cloudflare (403 on direct calls).
 * Requires VPS Playwright scraper to intercept internal API responses.
 *
 * Periods: 7D, 30D, 90D
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
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitunix'
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': '90d',
}

interface BitunixTrader {
  traderId?: string
  leaderId?: string
  uid?: string
  id?: string | number
  nickname?: string
  nickName?: string
  name?: string
  displayName?: string
  avatar?: string
  avatarUrl?: string
  headUrl?: string
  roi?: string | number
  yieldRate?: string | number
  totalRoi?: string | number
  returnRate?: string | number
  profit?: string | number
  pnl?: string | number
  totalProfit?: string | number
  totalPnl?: string | number
  winRate?: string | number
  win_rate?: string | number
  maxDrawdown?: string | number
  max_drawdown?: string | number
  followers?: number | string
  followerCount?: number | string
  copiers?: number | string
  copyCount?: number | string
  tradeCount?: number | string
  aum?: string | number
}

interface BitunixResponse {
  code?: number | string
  data?: {
    list?: BitunixTrader[]
    rows?: BitunixTrader[]
    records?: BitunixTrader[]
    items?: BitunixTrader[]
    traders?: BitunixTrader[]
    total?: number
  } | BitunixTrader[]
  msg?: string
}

function parseTrader(item: BitunixTrader, period: string, rank: number): TraderData | null {
  const id = String(item.traderId || item.leaderId || item.uid || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.yieldRate ?? item.totalRoi ?? item.returnRate)
  if (roi === null) return null
  // Normalize: if small decimal, convert to percentage
  if (Math.abs(roi) > 0 && Math.abs(roi) <= 1) roi *= 100

  const pnl = parseNum(item.profit ?? item.pnl ?? item.totalProfit ?? item.totalPnl)

  let winRate = parseNum(item.winRate ?? item.win_rate)
  if (winRate !== null && winRate > 0 && winRate <= 1) winRate *= 100
  winRate = normalizeWinRate(winRate)

  let maxDrawdown = parseNum(item.maxDrawdown ?? item.max_drawdown)
  if (maxDrawdown !== null && Math.abs(maxDrawdown) > 0 && Math.abs(maxDrawdown) <= 1) {
    maxDrawdown *= 100
  }

  const followers = parseNum(item.followers ?? item.followerCount ?? item.copiers ?? item.copyCount)
  const handle = item.nickname || item.nickName || item.name || item.displayName || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.bitunix.com/copy-trading/trader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar || item.avatarUrl || item.headUrl || null,
  }
}

function extractList(data: BitunixResponse): BitunixTrader[] {
  if (!data) return []
  if (Array.isArray(data)) return data
  if (Array.isArray(data.data)) return data.data
  if (data.data && typeof data.data === 'object') {
    const d = data.data as {
      list?: BitunixTrader[]
      rows?: BitunixTrader[]
      records?: BitunixTrader[]
      items?: BitunixTrader[]
      traders?: BitunixTrader[]
    }
    return d.list || d.rows || d.records || d.items || d.traders || []
  }
  return []
}

// Try direct API endpoints (may be CF-blocked)
const API_ENDPOINTS = [
  (page: number, period: string) =>
    `https://api.bitunix.com/api/v1/copy-trading/leader/list?page=${page}&pageSize=${PAGE_SIZE}&period=${period}&sortBy=roi&sortOrder=desc`,
  (page: number, period: string) =>
    `https://api.bitunix.com/api/v1/copy/trader/ranking?page=${page}&limit=${PAGE_SIZE}&period=${period}`,
  (page: number, period: string) =>
    `https://www.bitunix.com/api/copy-trading/square/leaders?page=${page}&size=${PAGE_SIZE}&period=${period}`,
]

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const periodStr = PERIOD_MAP[period] || '30d'
  const allTraders = new Map<string, BitunixTrader>()

  // Strategy 1: Try direct API endpoints
  for (const buildUrl of API_ENDPOINTS) {
    if (allTraders.size >= TARGET) break
    try {
      const url = buildUrl(1, periodStr)
      const data = await fetchJson<BitunixResponse>(url, {
        timeoutMs: 10000,
        headers: {
          Referer: 'https://www.bitunix.com/copy-trading/square',
          Origin: 'https://www.bitunix.com',
          Accept: 'application/json',
        },
      })
      const list = extractList(data)
      for (const item of list) {
        const id = String(item.traderId || item.leaderId || item.uid || item.id || '')
        if (id && id !== 'undefined' && !allTraders.has(id)) {
          allTraders.set(id, item)
        }
      }
      if (allTraders.size > 0) break
    } catch (err) {
      logger.warn(`[${SOURCE}] API endpoint failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Strategy 2: VPS proxy fallback
  if (allTraders.size === 0) {
    const vpsUrl = process.env.VPS_PROXY_URL || process.env.VPS_PROXY_SG
    if (vpsUrl) {
      for (const buildUrl of API_ENDPOINTS) {
        if (allTraders.size >= TARGET) break
        try {
          const url = buildUrl(1, periodStr)
          const res = await fetch(vpsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Proxy-Key': process.env.VPS_PROXY_KEY || '',
            },
            body: JSON.stringify({
              url,
              method: 'GET',
              headers: {
                Referer: 'https://www.bitunix.com/copy-trading/square',
                Accept: 'application/json',
              },
            }),
            signal: AbortSignal.timeout(15_000),
          })
          if (!res.ok) continue
          const data = (await res.json()) as BitunixResponse
          const list = extractList(data)
          for (const item of list) {
            const id = String(item.traderId || item.leaderId || item.uid || item.id || '')
            if (id && id !== 'undefined' && !allTraders.has(id)) {
              allTraders.set(id, item)
            }
          }
          if (allTraders.size > 0) break
        } catch (err) {
          logger.warn(`[${SOURCE}] VPS proxy failed: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }
  }

  // Strategy 3: VPS Playwright scraper (browser-based)
  if (allTraders.size === 0 && VPS_SCRAPER_KEY) {
    logger.warn(`[${SOURCE}] Trying VPS Playwright scraper...`)
    try {
      const scraperUrl = `${VPS_SCRAPER_URL}/scrape`
      const res = await fetch(scraperUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Proxy-Key': VPS_SCRAPER_KEY,
        },
        body: JSON.stringify({
          url: `https://www.bitunix.com/copy-trading/square?period=${periodStr}`,
          exchange: 'bitunix',
          type: 'futures',
        }),
        signal: AbortSignal.timeout(90_000),
      })
      if (res.ok) {
        const data = (await res.json()) as BitunixResponse
        const list = extractList(data)
        for (const item of list) {
          const id = String(item.traderId || item.leaderId || item.uid || item.id || '')
          if (id && id !== 'undefined' && !allTraders.has(id)) {
            allTraders.set(id, item)
          }
        }
        if (allTraders.size > 0) {
          logger.info(`[${SOURCE}] VPS scraper got ${allTraders.size} traders`)
        }
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] VPS scraper failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (allTraders.size === 0) {
    return {
      total: 0,
      saved: 0,
      error: 'No data from Bitunix — API blocked (403) and VPS scraper not configured for bitunix. ' +
        'Add bitunix scraper handler on VPS to enable.',
    }
  }

  const traders: TraderData[] = []
  let rank = 0
  for (const [, item] of Array.from(allTraders)) {
    rank++
    const trader = parseTrader(item, period, rank)
    if (trader && trader.roi !== null) {
      traders.push(trader)
    }
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)

  return { total: top.length, saved, error }
}

export async function fetchBitunix(
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
        result.periods[period] = { total: 0, saved: 0, error: err instanceof Error ? err.message : String(err) }
      }
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
