/**
 * Binance Web3 Leaderboard — Inline fetcher for Vercel serverless
 *
 * Source page: https://web3.binance.com/zh-CN/leaderboard?chain=bsc
 *
 * The Binance Web3 leaderboard is an SPA that loads trader data via internal
 * APIs. The exact endpoint is not publicly documented, so we try the known
 * Binance bapi patterns. If none work, we return gracefully with zero results
 * (the cron scheduler will retry on the next run).
 *
 * [WARN] GEO-BLOCKED from US IPs (HTTP 451).
 * Works correctly from Vercel Japan/Singapore datacenters.
 *
 * Known API patterns tried:
 *  1. /bapi/composite/v1/public/future/leaderboard/getLeaderboardRank
 *  2. /bapi/futures/v1/public/future/leaderboard/getOtherLeaderboardBaseInfo (single)
 *
 * Field mappings based on original import_binance_web3.mjs:
 *  - traderId: address / wallet / walletAddress
 *  - roi: roi / pnlPct / returnRate / profitRate (decimal → *100 if <10)
 *  - pnl: pnl / profit / totalPnl
 *  - winRate: winRate / win_rate / successRate
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

const SOURCE = 'binance_web3'
const TARGET = 500
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'

// Binance community leaderboard API (works for on-chain/web3 traders)
// Note: /bapi/composite/ returns 404, /bapi/futures/ is the correct prefix (returns 451 geo-block)
const LEADERBOARD_URL =
  'https://www.binance.com/bapi/futures/v1/public/future/leaderboard/getLeaderboardRank'

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Origin: 'https://www.binance.com',
  Referer: 'https://www.binance.com/en/leaderboard',
}

// Helper to fetch with proxy fallback
async function fetchWithProxyFallback<T>(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown; timeoutMs?: number }
): Promise<T> {
  // Try direct first
  try {
    return await fetchJson<T>(url, opts)
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    // If geo-blocked or WAF blocked, try proxy
    if (msg.includes('451') || msg.includes('403') || msg.includes('Access Denied')) {
      if (PROXY_URL) {
        const proxyTarget = `${PROXY_URL}?url=${encodeURIComponent(url)}`
        return await fetchJson<T>(proxyTarget, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: opts.body,
          timeoutMs: opts.timeoutMs,
        })
      }
    }
    throw err
  }
}

const PERIOD_MAP: Record<string, string> = {
  '7D': 'WEEKLY',
  '30D': 'MONTHLY',
  '90D': 'QUARTERLY',
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeaderboardEntry {
  encryptedUid?: string
  nickName?: string
  userPhotoUrl?: string
  rank?: number
  value?: number          // ROI value (decimal)
  pnl?: number
  roi?: number
  followerCount?: number
  // On-chain specific
  address?: string
  wallet?: string
  walletAddress?: string
  pnlPct?: number
  returnRate?: number
  profitRate?: number
  winRate?: number
  win_rate?: number
  successRate?: number
  mdd?: number
  maxDrawdown?: number
  max_drawdown?: number
  totalPnl?: number
  profit?: number
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function tryLeaderboardApi(
  period: string
): Promise<LeaderboardEntry[]> {
  const timeRange = PERIOD_MAP[period] || 'QUARTERLY'
  try {
    const data = await fetchWithProxyFallback<{
      data?: LeaderboardEntry[]
      code?: string
      msg?: string
    }>(LEADERBOARD_URL, {
      method: 'POST',
      headers: HEADERS,
      body: {
        isShared: true,
        isTrader: false,
        periodType: timeRange,
        statisticsType: 'ROI',
        tradeType: 'PERPETUAL',
      },
      timeoutMs: 20000,
    })

    if (data?.data && Array.isArray(data.data)) {
      return data.data
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Binance returns HTTP 451 for geo-blocked requests
    if (msg.includes('451') || msg.includes('403')) {
      logger.warn(`[binance-web3] Geo-blocked (HTTP 451/403) — proxy fallback failed`)
    } else {
      logger.warn(`[binance-web3] leaderboard API failed: ${msg}`)
    }
  }
  return []
}

// ---------------------------------------------------------------------------
// Period fetcher
// ---------------------------------------------------------------------------

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const entries = await tryLeaderboardApi(period)

  if (entries.length === 0) {
    logger.warn(`[binance-web3] No data for ${period}`)
    return { total: 0, saved: 0, error: 'No data — likely geo-blocked (HTTP 451). Deploy to Vercel Japan/SG.' }
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = []

  for (const item of entries) {
    const id =
      item.encryptedUid ||
      item.address ||
      item.wallet ||
      item.walletAddress ||
      ''
    if (!id) continue

    // ROI: try multiple field names
    let roi = parseNum(
      item.value ?? item.roi ?? item.pnlPct ?? item.returnRate ?? item.profitRate
    )
    if (roi == null) continue
    // If ROI is in decimal form (< 10), convert to percentage
    roi = normalizeROI(roi, SOURCE) ?? roi

    const pnl = parseNum(item.pnl ?? item.profit ?? item.totalPnl)
    const wrRaw = parseNum(item.winRate ?? item.win_rate ?? item.successRate)
    const winRate = normalizeWinRate(wrRaw, getWinRateFormat(SOURCE))
    const mddRaw = parseNum(item.mdd ?? item.maxDrawdown ?? item.max_drawdown)
    const maxDrawdown = mddRaw != null ? Math.abs(mddRaw) : null

    traders.push({
      source: SOURCE,
      source_trader_id: id,
      handle: item.nickName || `${id.slice(0, 10)}...`,
      profile_url: item.address
        ? `https://web3.binance.com/en/leaderboard/detail/${item.address}`
        : null,
      season_id: period,
      roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      followers: item.followerCount || null,
      arena_score: calculateArenaScore(roi, pnl, maxDrawdown, winRate, period),
      captured_at: capturedAt,
    })
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

  return { total: top.length, saved, error }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function fetchBinanceWeb3(
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
