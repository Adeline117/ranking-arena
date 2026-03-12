/**
 * dYdX v4 — Inline fetcher for Vercel serverless
 *
 * Primary data source: dYdX external API (Heroku)
 *   - Weekly CLC (competition leaderboard): PnL + equity snapshots, ~3500 traders
 *   - Fee leaderboard: total fees paid, ~2800 traders
 *
 * The old indexer /v4/leaderboard/pnl endpoint was removed (~2026-03).
 * Enrichment still uses the indexer for historical PnL and subaccount data.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared'
import { type EquityCurvePoint, type StatsDetail, upsertEquityCurve, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'dydx'
const PROXY_URL = process.env.CLOUDFLARE_PROXY_URL || 'https://ranking-arena-proxy.broosbook.workers.dev'
const INDEXER_URL = 'https://indexer.dydx.trade'
const HEROKU_API = 'https://pp-external-api-ffb2ad95ef03.herokuapp.com/api'
const TARGET = 500
const ENRICH_LIMIT = 100 // Reduced from 300 to fit within 240s timeout
const ENRICH_CONCURRENCY = 5
const ENRICH_DELAY_MS = 300

// Cache Heroku data across periods to avoid re-fetching 3x
let _herokuCache: HerokuClcEntry[] | null = null

// ── API response types ──

interface HerokuClcEntry {
  address: string
  pnl: number
  volume: number
  position: number
  dollarReward?: number
  startOfThisWeekPnlSnapshot?: {
    equity: string
    netTransfers: string
    totalPnl: string
    createdAt: string
  }
  latestPnlSnapshot?: {
    equity: string
    netTransfers: string
    totalPnl: string
    createdAt: string
  }
}

interface HerokuClcResponse {
  success: boolean
  data: HerokuClcEntry[]
  pagination: { total: number; totalPages: number; page: number; perPage: number }
}

// ── Copin API types ──

interface CopinDydxTrader {
  account: string
  ranking: number
  totalPnl: number
  totalVolume: number
  totalTrade: number
  totalWin: number
  totalLose: number
}

interface CopinDydxResponse {
  data: CopinDydxTrader[]
  meta: { total: number; totalPages: number; limit: number; offset: number }
}

// Copin API period mapping
const COPIN_PERIOD: Record<string, string> = { '7D': 'WEEK', '30D': 'MONTH', '90D': 'MONTH' }

interface DydxHistoricalPnl {
  equity: string
  totalPnl: string
  netTransfers: string
  createdAt: string
}

interface DydxHistoricalPnlResponse {
  historicalPnl?: DydxHistoricalPnl[]
}

interface DydxSubaccountResponse {
  subaccount?: {
    equity?: string
    freeCollateral?: string
    openPerpetualPositions?: Record<string, unknown>
  }
}

// ── Fetch helpers ──

/**
 * Fetch leaderboard from dYdX Heroku external API (weekly CLC competition).
 * This is the primary source since the indexer /v4/leaderboard/pnl was removed.
 * Returns traders sorted by PnL with equity snapshots.
 */
async function fetchLeaderboardFromHeroku(): Promise<HerokuClcEntry[]> {
  const allTraders: HerokuClcEntry[] = []
  const perPage = 200
  const maxPages = Math.ceil(TARGET / perPage) + 1

  for (let page = 1; page <= maxPages; page++) {
    try {
      const url = `${HEROKU_API}/dydx-weekly-clc?perPage=${perPage}&page=${page}`
      const data = await fetchJson<HerokuClcResponse>(url, { timeoutMs: 20000 })

      if (!data?.success || !data.data || data.data.length === 0) break

      allTraders.push(...data.data)
      logger.warn(`[dydx] Heroku CLC page ${page}: ${data.data.length} entries (total: ${allTraders.length}/${data.pagination.total})`)

      if (allTraders.length >= TARGET || page >= data.pagination.totalPages) break
      await sleep(300)
    } catch (err) {
      logger.warn(`[dydx] Heroku CLC page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
      break
    }
  }

  return allTraders
}

/**
 * Strategy 2: Copin API fallback for dYdX leaderboard data.
 * Free, no API key needed. ~1000 traders available.
 */
async function fetchViaCopinApi(period: string): Promise<TraderData[]> {
  const statisticType = COPIN_PERIOD[period] || 'WEEK'
  const now = new Date()
  const queryDate = new Date(now.getFullYear(), now.getMonth(), 1).getTime()

  const traders: TraderData[] = []
  const capturedAt = new Date().toISOString()
  const pageSize = 100
  const maxPages = Math.ceil(TARGET / pageSize)

  for (let page = 0; page < maxPages; page++) {
    const url = `https://api.copin.io/leaderboards/page?protocol=DYDX&statisticType=${statisticType}&queryDate=${queryDate}&limit=${pageSize}&offset=${page * pageSize}&sort_by=ranking&sort_type=asc`

    const data = await fetchJson<CopinDydxResponse>(url, { timeoutMs: 15000 })
    if (!data?.data?.length) break

    for (const t of data.data) {
      if (!t.account) continue

      // Compute ROI from PnL / estimated capital (volume / avg leverage ~10x)
      const estimatedCapital = t.totalVolume > 0 ? t.totalVolume / 10 : 0
      const roi = estimatedCapital > 100 ? (t.totalPnl / estimatedCapital) * 100 : 0
      if (roi === 0 && t.totalPnl === 0) continue

      const winRate = t.totalTrade > 0 ? (t.totalWin / t.totalTrade) * 100 : null
      const addr = t.account

      traders.push({
        source: SOURCE,
        source_trader_id: addr,
        handle: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
        profile_url: `https://dydx.trade/portfolio/${addr}`,
        season_id: period,
        rank: t.ranking || traders.length + 1,
        roi,
        pnl: t.totalPnl || null,
        win_rate: winRate,
        max_drawdown: null,
        arena_score: calculateArenaScore(roi, t.totalPnl, null, winRate, period),
        captured_at: capturedAt,
      })
    }

    if (data.data.length < pageSize) break
    await sleep(300)
  }

  return traders
}

async function fetchHistoricalPnl(address: string): Promise<EquityCurvePoint[]> {
  try {
    // Try proxy first
    const proxyUrl = `${PROXY_URL}/dydx/historical-pnl?address=${address}&subaccountNumber=0&limit=90`
    let historicalPnl: DydxHistoricalPnl[] | undefined

    try {
      const data = await fetchJson<DydxHistoricalPnlResponse>(proxyUrl, { timeoutMs: 5000 })
      historicalPnl = data?.historicalPnl
    } catch {
      // Proxy failed, try direct
    }

    if (!historicalPnl || historicalPnl.length === 0) {
      const directUrl = `${INDEXER_URL}/v4/historical-pnl?address=${address}&subaccountNumber=0&limit=90`
      const directData = await fetchJson<DydxHistoricalPnlResponse>(directUrl, { timeoutMs: 5000 })
      historicalPnl = directData?.historicalPnl
    }

    if (!historicalPnl || historicalPnl.length === 0) return []

    // Convert to equity curve format
    return historicalPnl
      .map(h => ({
        date: h.createdAt.split('T')[0],
        roi: 0,
        pnl: parseFloat(h.totalPnl) || 0,
      }))
      .reverse() // API returns newest first
      .map((point, idx, arr) => {
        const initialPnl = arr[0]?.pnl || 0
        const currentPnl = point.pnl
        const pnlDiff = currentPnl - initialPnl
        const roi = initialPnl !== 0 ? (pnlDiff / Math.abs(initialPnl)) * 100 : 0
        return { ...point, roi }
      })
  } catch (err) {
    logger.warn(`[${SOURCE}] Equity curve fetch failed: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
}

async function fetchSubaccountEquity(address: string): Promise<number | null> {
  try {
    const proxyUrl = `${PROXY_URL}/dydx/subaccount?address=${address}&subaccountNumber=0`
    const data = await fetchJson<DydxSubaccountResponse>(proxyUrl, { timeoutMs: 5000 })
    if (data?.subaccount?.equity) {
      return parseFloat(data.subaccount.equity)
    }
  } catch {
    // Proxy failed, try direct
  }
  try {
    const directUrl = `${INDEXER_URL}/v4/addresses/${address}/subaccounts/0`
    const data = await fetchJson<DydxSubaccountResponse>(directUrl, { timeoutMs: 5000 })
    if (data?.subaccount?.equity) {
      return parseFloat(data.subaccount.equity)
    }
  } catch (err) {
    logger.warn(`[${SOURCE}] Subaccount equity fetch failed: ${err instanceof Error ? err.message : String(err)}`)
  }
  return null
}

// ── Enrichment ──

interface EnrichableTrader {
  address: string
  pnl: number
  equity: number | null
  equityCurve: EquityCurvePoint[]
  maxDrawdown: number | null
  volume: number
}

async function enrichTraders(traders: EnrichableTrader[]): Promise<void> {
  const toEnrich = traders.slice(0, ENRICH_LIMIT)

  for (let i = 0; i < toEnrich.length; i += ENRICH_CONCURRENCY) {
    const batch = toEnrich.slice(i, i + ENRICH_CONCURRENCY)
    await Promise.all(
      batch.map(async (trader) => {
        const [curve, equity] = await Promise.all([
          fetchHistoricalPnl(trader.address),
          fetchSubaccountEquity(trader.address),
        ])
        trader.equityCurve = curve
        trader.equity = equity

        // Calculate MDD from equity curve
        if (curve.length >= 2) {
          let peak = curve[0].pnl ?? 0
          let maxDD = 0
          for (const point of curve) {
            const pnl = point.pnl ?? 0
            if (pnl > peak) peak = pnl
            if (peak > 0) {
              const dd = ((peak - pnl) / peak) * 100
              if (dd > maxDD) maxDD = dd
            }
          }
          trader.maxDrawdown = maxDD > 0 && maxDD < 200 ? maxDD : null
        }
      })
    )
    await sleep(ENRICH_DELAY_MS)
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // The Heroku API only has weekly competition data (no period filter).
  // Cache across periods to avoid fetching 3x (saves ~40s).
  if (!_herokuCache) {
    _herokuCache = await fetchLeaderboardFromHeroku()
  }
  const entries = _herokuCache

  // Strategy 2: Copin API fallback
  if (entries.length === 0) {
    logger.warn(`[${SOURCE}] Heroku API returned 0 entries, trying Copin API fallback...`)
    try {
      const copinTraders = await fetchViaCopinApi(period)
      if (copinTraders.length > 0) {
        logger.info(`[${SOURCE}] Copin API returned ${copinTraders.length} traders for ${period}`)
        const { saved, error } = await upsertTraders(supabase, copinTraders)
        return { total: copinTraders.length, saved, error }
      }
    } catch (err) {
      logger.warn(`[${SOURCE}] Copin API failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    return { total: 0, saved: 0, error: 'No data from dYdX Heroku API or Copin API' }
  }

  // Parse to enrichable format using Heroku CLC data
  const parsed: EnrichableTrader[] = entries.map(e => {
    const latestEquity = e.latestPnlSnapshot?.equity ? parseFloat(e.latestPnlSnapshot.equity) : null
    return {
      address: e.address,
      pnl: e.pnl || 0,
      equity: latestEquity,
      equityCurve: [],
      maxDrawdown: null,
      volume: e.volume || 0,
    }
  })

  // Filter and sort by absolute PnL (both positive and negative PnL traders are valuable)
  const validTraders = parsed.filter(t => t.address && t.address.startsWith('dydx'))
  validTraders.sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl))
  const topTraders = validTraders.slice(0, TARGET)

  // DISABLED 2026-03-12: Enrichment moved to batch-enrich to avoid Cloudflare 120s timeout
  // Inline enrichment causes batch-fetch-traders to exceed timeout when combined with fetch
  // Enrichment will be handled by dedicated batch-enrich jobs (no HTTP, no Cloudflare limit)
  //
  // if (period === '90D') {
  //   await enrichTraders(topTraders)
  // }
  //
  // if (period === '90D') {
  //   logger.warn(`[${SOURCE}] Saving equity curves and stats details for ${period}...`)
  //   ...
  // }

  // Build TraderData
  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = topTraders.map((t, idx) => {
    // Estimate ROI: PnL / equity (or assume $10k if unknown)
    const capital = t.equity || 10000
    const roi = capital > 0 ? (t.pnl / capital) * 100 : 0
    const clampedRoi = Math.max(-100, Math.min(10000, roi))

    return {
      source: SOURCE,
      source_trader_id: t.address,
      handle: `${t.address.slice(0, 6)}...${t.address.slice(-4)}`,
      profile_url: `https://dydx.trade/portfolio/${t.address}`,
      season_id: period,
      rank: idx + 1,
      roi: clampedRoi,
      pnl: t.pnl || null,
      win_rate: null,
      max_drawdown: t.maxDrawdown,
      aum: t.equity,
      arena_score: calculateArenaScore(clampedRoi, t.pnl, t.maxDrawdown, null, period),
      captured_at: capturedAt,
    }
  })

  const { saved, error } = await upsertTraders(supabase, traders)
  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchDydx(
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
        result.periods[period] = {
          total: 0,
          saved: 0,
          error: err instanceof Error ? err.message : String(err),
        }
      }
      if (periods.indexOf(period) < periods.length - 1) await sleep(2000)
    }
  } catch (err) {
    captureException(err instanceof Error ? err : new Error(String(err)), {
      tags: { platform: SOURCE },
    })
    logger.error(`[${SOURCE}] Fetch failed`, err instanceof Error ? err : new Error(String(err)))
  }

  _herokuCache = null // Clear cache for next invocation
  result.duration = Date.now() - start
  return result
}
