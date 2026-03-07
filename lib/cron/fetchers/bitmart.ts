/**
 * BitMart Futures — Inline fetcher for Vercel serverless
 *
 * BitMart copy trading website is behind Cloudflare, requiring VPS scraper.
 * API V1 is deprecated, V2 unknown. Only VPS Playwright scraper works.
 *
 * Note: BitMart does NOT support 90D window, only 7D and 30D.
 * Note: BitMart does NOT provide win_rate or max_drawdown in list endpoint.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  parseNum,
  sleep,
} from './shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'bitmart'
const VPS_SCRAPER_URL = process.env.VPS_SCRAPER_URL || 'http://45.76.152.169:3456'
const VPS_SCRAPER_KEY = process.env.VPS_PROXY_KEY || ''

interface BitmartTrader {
  traderId?: string
  id?: string | number
  nickname?: string
  nickName?: string
  name?: string
  avatar?: string
  avatarUrl?: string
  roi?: string | number
  yieldRate?: string | number
  totalRoi?: string | number
  profit?: string | number
  pnl?: string | number
  totalProfit?: string | number
  followers?: number | string
  followerCount?: number | string
  copiers?: number | string
  copyCount?: number | string
  winRate?: string | number
  win_rate?: string | number
  maxDrawdown?: string | number
  tradeCount?: number | string
}

function parseTrader(item: BitmartTrader, period: string, rank: number): TraderData | null {
  const id = String(item.traderId || item.id || '')
  if (!id || id === 'undefined') return null

  let roi = parseNum(item.roi ?? item.yieldRate ?? item.totalRoi)
  if (roi === null) return null
  // Normalize: if small decimal, convert to percentage
  if (Math.abs(roi) > 0 && Math.abs(roi) <= 1) roi *= 100

  const pnl = parseNum(item.profit ?? item.pnl ?? item.totalProfit)
  const winRate = parseNum(item.winRate ?? item.win_rate)
  const maxDrawdown = item.maxDrawdown != null ? Math.abs(parseNum(item.maxDrawdown) || 0) : null
  const followers = parseNum(item.followers ?? item.followerCount ?? item.copiers ?? item.copyCount)
  const handle = item.nickname || item.nickName || item.name || `Trader_${id.slice(0, 8)}`

  return {
    source: SOURCE,
    source_trader_id: id,
    handle,
    profile_url: `https://www.bitmart.com/copy-trading/trader/${id}`,
    season_id: period,
    rank,
    roi,
    pnl,
    win_rate: winRate,
    max_drawdown: maxDrawdown,
    followers: followers ? Math.round(followers) : null,
    arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
    captured_at: new Date().toISOString(),
    avatar_url: item.avatar || item.avatarUrl || null,
  }
}

async function fetchViaVpsScraper(period: string): Promise<BitmartTrader[]> {
  const scraperPeriod = period === '7D' ? '7d' : '30d'
  const url = `${VPS_SCRAPER_URL}/scrape`
  const body = {
    url: `https://www.bitmart.com/copy-trading/list?period=${scraperPeriod}`,
    exchange: 'bitmart',
    type: 'futures',
    key: VPS_SCRAPER_KEY,
  }

  const resp = await fetchJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!resp) return []

  const data = resp as { traders?: BitmartTrader[]; data?: BitmartTrader[] }
  return data.traders || data.data || []
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // BitMart only supports 7D and 30D
  if (period === '90D') {
    return { total: 0, saved: 0, error: 'BitMart does not support 90D window' }
  }

  try {
    const traders = await fetchViaVpsScraper(period)

    if (!traders.length) {
      return { total: 0, saved: 0, error: `VPS scraper returned 0 traders for ${period}` }
    }

    const parsed: TraderData[] = []
    for (let i = 0; i < traders.length; i++) {
      const t = parseTrader(traders[i], period, i + 1)
      if (t) parsed.push(t)
    }

    if (parsed.length > 0) {
      await upsertTraders(supabase, parsed)
    }

    return { total: traders.length, saved: parsed.length }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logger.error(`[bitmart] fetchPeriod ${period} error: ${msg}`)
    captureException(error instanceof Error ? error : new Error(msg))
    return { total: 0, saved: 0, error: msg }
  }
}

export async function fetchBitmart(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

  for (const period of periods) {
    try {
      result.periods[period] = await fetchPeriod(supabase, period)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      captureException(error, { tags: { platform: SOURCE, period } })
      logger.error(`[${SOURCE}] Period ${period} failed`, error)
      result.periods[period] = { total: 0, saved: 0, error: error.message }
    }
    if (periods.indexOf(period) < periods.length - 1) await sleep(1000)
  }

  result.duration = Date.now() - start
  return result
}
