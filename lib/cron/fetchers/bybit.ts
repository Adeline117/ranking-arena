/**
 * Bybit Copy Trading — Inline fetcher for Vercel serverless
 * API: https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list
 *
 * Uses the beehive public API directly (no puppeteer).
 * metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
 *
 * ⚠️  WAF-BLOCKED from US residential IPs (Akamai "Access Denied").
 * Strategy:
 * 1. Try direct API (works from Vercel SG/JP regions)
 * 2. Fall back to Cloudflare Worker proxy
 * 3. Return appropriate error if all methods fail
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

const SOURCE = 'bybit'
const DIRECT_API_URL =
  'https://www.bybit.com/x-api/fapi/beehive/public/v1/common/dynamic-leader-list'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const TARGET = 500
const PAGE_SIZE = 50

const PERIOD_MAP: Record<string, string> = {
  '7D': 'DATA_DURATION_SEVEN_DAY',
  '30D': 'DATA_DURATION_THIRTY_DAY',
  '90D': 'DATA_DURATION_NINETY_DAY',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePercent(s: unknown): number | null {
  if (s == null) return null
  const str = String(s).replace(/,/g, '')
  const m = str.match(/([+-]?)(\d+(?:\.\d+)?)%?/)
  if (!m) return null
  const sign = m[1] === '-' ? -1 : 1
  return parseFloat(m[2]) * sign
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface BybitLeaderDetail {
  leaderUserId?: string
  leaderMark?: string
  nickName?: string
  profilePhoto?: string
  currentFollowerCount?: number | string
  metricValues?: string[]
}

interface BybitApiResponse {
  retCode?: number
  result?: {
    leaderDetails?: BybitLeaderDetail[]
  }
}

// ---------------------------------------------------------------------------
// Fetch helpers with proxy fallback
// ---------------------------------------------------------------------------

async function fetchBybitPage(
  pageNo: number,
  pageSize: number,
  duration: string
): Promise<BybitApiResponse | null> {
  const directUrl =
    `${DIRECT_API_URL}?pageNo=${pageNo}&pageSize=${pageSize}` +
    `&dataDuration=${duration}` +
    `&sortField=LEADER_SORT_FIELD_SORT_ROI`

  const proxyUrl =
    `${PROXY_URL}/bybit/copy-trading?pageNo=${pageNo}&pageSize=${pageSize}&period=${duration}`

  // Strategy 1: Try direct API first (works from non-US IPs)
  try {
    const data = await fetchJson<BybitApiResponse>(directUrl)
    if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
      console.log(`[bybit] Direct API success, page ${pageNo}`)
      return data
    }
  } catch (err) {
    console.log(`[bybit] Direct API failed: ${err instanceof Error ? err.message : err}`)
  }

  // Strategy 2: Try Cloudflare Worker proxy
  try {
    const data = await fetchJson<BybitApiResponse>(proxyUrl)
    if (data?.result?.leaderDetails && data.result.leaderDetails.length > 0) {
      console.log(`[bybit] Proxy success, page ${pageNo}`)
      return data
    }
  } catch (err) {
    console.log(`[bybit] Proxy failed: ${err instanceof Error ? err.message : err}`)
  }

  return null
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const duration = PERIOD_MAP[period] || PERIOD_MAP['30D']
  const maxPages = Math.ceil(TARGET / PAGE_SIZE)
  const allTraders = new Map<string, BybitLeaderDetail>()
  let lastError: string | undefined

  for (let pageNo = 1; pageNo <= maxPages; pageNo++) {
    const data = await fetchBybitPage(pageNo, PAGE_SIZE, duration)
    
    if (!data) {
      lastError = 'WAF-blocked from both direct API and proxy'
      break
    }

    const details = data.result?.leaderDetails || []
    if (details.length === 0) break

    for (const item of details) {
      const id = String(item.leaderUserId || item.leaderMark || '')
      if (!id || allTraders.has(id)) continue
      allTraders.set(id, item)
    }

    if (details.length < PAGE_SIZE || allTraders.size >= TARGET) break
    await sleep(500)
  }

  if (allTraders.size === 0) {
    return { total: 0, saved: 0, error: lastError || 'No data retrieved' }
  }

  // Map to TraderData
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const [id, item] of Array.from(allTraders)) {
    const mv = item.metricValues || []
    // metricValues: [ROI, Drawdown, followerProfit, WinRate, PLRatio, SharpeRatio]
    const roi = parsePercent(mv[0])
    if (roi == null || roi === 0) continue

    const maxDrawdown = parsePercent(mv[1])
    const pnl = parseNum(mv[2])
    const winRate = normalizeWinRate(parsePercent(mv[3]))
    const followers = parseInt(String(item.currentFollowerCount || '0'), 10) || null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `Bybit_${id.slice(0, 8)}`,
      profile_url: `https://www.bybit.com/copyTrade/tradeInfo?leaderMark=${id}`,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
      followers,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
  }

  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  const { saved, error } = await upsertTraders(supabase, top)
  return { total: top.length, saved, error }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function fetchBybit(
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
