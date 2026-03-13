/**
 * Hyperliquid — Inline fetcher for Vercel serverless
 * APIs:
 *   - Leaderboard: https://stats-data.hyperliquid.xyz/Mainnet/leaderboard
 *   - Win rate:    POST https://api.hyperliquid.xyz/info  (userFillsByTime)
 *   - MDD:         POST https://api.hyperliquid.xyz/info  (portfolio)
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from './shared.js'
import { type StatsDetail, upsertStatsDetail } from './enrichment.js'
import { logger } from '../../logger.js'

const SOURCE = 'hyperliquid'
const STATS_API = 'https://stats-data.hyperliquid.xyz/Mainnet'
const INFO_API = 'https://api.hyperliquid.xyz/info'
const TARGET = 500
const ENRICH_LIMIT = 300 // Increased for better field coverage (local cron can handle more)
const CONCURRENCY = 8
const DELAY_MS = 100

const WINDOW_MAP: Record<string, string> = {
  '7D': 'week',
  '30D': 'month',
  '90D': 'allTime',
}
const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }
const ROI_MAX_CAP = 99999

// ── API response types ──

interface WindowPerf {
  pnl?: string | number
  roi?: string | number
}

interface LeaderboardRow {
  ethAddress: string
  displayName?: string
  accountValue?: string | number
  windowPerformances?: Array<[string, WindowPerf]> | Record<string, WindowPerf>
}

interface LeaderboardResponse {
  leaderboardRows?: LeaderboardRow[]
}

interface FillEntry {
  closedPnl?: string
}

// ── Win rate & trades count enrichment ──

// Phase 3: Enhanced stats result with avgProfit/avgLoss
interface EnrichedStatsResult {
  winRate: number | null
  tradesCount: number | null
  avgProfit: number | null
  avgLoss: number | null
  totalWins: number | null
  totalLosses: number | null
}

async function fetchEnrichedStats(
  address: string,
  period: string
): Promise<EnrichedStatsResult> {
  try {
    const days = WINDOW_DAYS[period] || 30
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000

    const fills = await fetchJson<FillEntry[]>(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'userFillsByTime', user: address, startTime, aggregateByTime: true },
      timeoutMs: 8000,
    })

    if (!Array.isArray(fills) || fills.length === 0) {
      return { winRate: null, tradesCount: null, avgProfit: null, avgLoss: null, totalWins: null, totalLosses: null }
    }

    const closed = fills.filter((f) => {
      const pnl = parseFloat(f.closedPnl || '0')
      return pnl !== 0
    })

    if (closed.length === 0) {
      return {
        winRate: null,
        tradesCount: fills.length > 0 ? fills.length : null,
        avgProfit: null,
        avgLoss: null,
        totalWins: null,
        totalLosses: null,
      }
    }

    // Phase 3: Calculate avgProfit and avgLoss
    const wins = closed.filter((f) => parseFloat(f.closedPnl || '0') > 0)
    const losses = closed.filter((f) => parseFloat(f.closedPnl || '0') < 0)

    let totalProfit = 0
    for (const w of wins) {
      totalProfit += parseFloat(w.closedPnl || '0')
    }

    let totalLoss = 0
    for (const l of losses) {
      totalLoss += Math.abs(parseFloat(l.closedPnl || '0'))
    }

    return {
      winRate: (wins.length / closed.length) * 100,
      tradesCount: closed.length,
      avgProfit: wins.length > 0 ? totalProfit / wins.length : null,
      avgLoss: losses.length > 0 ? totalLoss / losses.length : null,
      totalWins: wins.length,
      totalLosses: losses.length,
    }
  } catch {
    return { winRate: null, tradesCount: null, avgProfit: null, avgLoss: null, totalWins: null, totalLosses: null }
  }
}

// ── MDD enrichment ──

type PortfolioEntry = [string, { accountValueHistory?: Array<[number, string]>; pnlHistory?: Array<[number, string]> }]

async function fetchMaxDrawdown(
  address: string,
  period: string
): Promise<number | null> {
  try {
    const portfolio = await fetchJson<PortfolioEntry[]>(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'portfolio', user: address },
      timeoutMs: 8000,
    })

    if (!Array.isArray(portfolio)) return null

    const periodKey: Record<string, string> = {
      '7D': 'perpWeek',
      '30D': 'perpMonth',
      '90D': 'perpAllTime',
    }
    const key = periodKey[period] || 'perpMonth'
    const entry = portfolio.find(([k]) => k === key)
    if (!entry) return null

    const periodData = entry[1]
    const avh = periodData?.accountValueHistory
    const ph = periodData?.pnlHistory
    if (!avh?.length || !ph?.length || ph.length < 2) return null

    let maxDrawdown = 0
    for (let i = 0; i < ph.length; i++) {
      const startAv = parseFloat(avh[i]?.[1] || '0')
      const startPnl = parseFloat(ph[i][1])
      if (startAv <= 0) continue

      for (let j = i + 1; j < ph.length; j++) {
        const endPnl = parseFloat(ph[j][1])
        const dd = (endPnl - startPnl) / startAv
        if (dd < maxDrawdown) maxDrawdown = dd
      }
    }

    const result = Math.abs(maxDrawdown) * 100
    return result > 0 && result < 200 ? result : null
  } catch {
    return null
  }
}

// ── Batch enrichment ──

interface EnrichableTrader {
  address: string
  displayName: string
  roi: number
  pnl: number
  aum: number | null
  winRate: number | null
  maxDrawdown: number | null
  tradesCount: number | null
  // Phase 3: Additional enrichment fields
  avgProfit: number | null
  avgLoss: number | null
  totalWins: number | null
  totalLosses: number | null
}

async function enrichTraders(
  traders: EnrichableTrader[],
  period: string
): Promise<void> {
  const toEnrich = traders.slice(0, ENRICH_LIMIT)

  for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
    const batch = toEnrich.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (trader) => {
        // Phase 3: Use enhanced stats fetch
        const [statsResult, maxDrawdown] = await Promise.all([
          fetchEnrichedStats(trader.address, period),
          fetchMaxDrawdown(trader.address, period),
        ])
        trader.winRate = statsResult.winRate
        trader.tradesCount = statsResult.tradesCount
        trader.avgProfit = statsResult.avgProfit
        trader.avgLoss = statsResult.avgLoss
        trader.totalWins = statsResult.totalWins
        trader.totalLosses = statsResult.totalLosses
        trader.maxDrawdown = maxDrawdown
      })
    )
    await sleep(DELAY_MS)
  }
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const data = await fetchJson<LeaderboardResponse>(`${STATS_API}/leaderboard`, {
    timeoutMs: 20000,
  })
  if (!data?.leaderboardRows) {
    return { total: 0, saved: 0, error: 'No leaderboard data' }
  }

  const windowKey = WINDOW_MAP[period]

  // Parse leaderboard rows
  const parsed: EnrichableTrader[] = []

  for (const item of data.leaderboardRows) {
    // windowPerformances can be array of tuples or object
    let windowData: WindowPerf | undefined
    if (Array.isArray(item.windowPerformances)) {
      windowData = item.windowPerformances.find(([key]) => key === windowKey)?.[1]
    } else if (item.windowPerformances) {
      windowData = (item.windowPerformances as Record<string, WindowPerf>)[windowKey]
    }

    const pnl = windowData?.pnl ? Number(windowData.pnl) : 0
    const accountValue = Number(item.accountValue) || 0
    let roi = windowData?.roi ? Number(windowData.roi) * 100 : 0

    // Anomaly fix: if roi ≈ pnl, the API returned PNL as roi
    if (pnl !== 0 && Math.abs(roi - pnl) < 0.01) {
      roi = accountValue > 0 ? (pnl / accountValue) * 100 : 0
    }

    // Cap extreme ROI
    if (Math.abs(roi) > ROI_MAX_CAP) {
      roi = roi > 0 ? ROI_MAX_CAP : -ROI_MAX_CAP
    }

    if (roi <= 0) continue

    parsed.push({
      address: item.ethAddress.toLowerCase(),
      displayName:
        item.displayName ||
        `${item.ethAddress.slice(0, 6)}...${item.ethAddress.slice(-4)}`,
      roi,
      pnl,
      aum: accountValue > 0 ? accountValue : null,
      winRate: null,
      maxDrawdown: null,
      tradesCount: null,
      // Phase 3: Initialize new fields
      avgProfit: null,
      avgLoss: null,
      totalWins: null,
      totalLosses: null,
    })
  }

  // Sort by ROI and take top TARGET
  parsed.sort((a, b) => b.roi - a.roi)
  const topTraders = parsed.slice(0, TARGET)

  // Enrich with win rate + MDD (limited for serverless)
  await enrichTraders(topTraders, period)

  // Phase 3: Save stats_detail for ALL periods (extended from 90D only)
  logger.warn(`[${SOURCE}] Saving stats details for ${Math.min(topTraders.length, ENRICH_LIMIT)} traders (${period})...`)
  let statsSaved = 0
  for (const trader of topTraders.slice(0, ENRICH_LIMIT)) {
    const stats: StatsDetail = {
      totalTrades: trader.tradesCount,
      profitableTradesPct: trader.winRate,
      avgHoldingTimeHours: null,
      // Phase 3: Save avgProfit and avgLoss from fills data
      avgProfit: trader.avgProfit,
      avgLoss: trader.avgLoss,
      largestWin: null,
      largestLoss: null,
      sharpeRatio: null,
      maxDrawdown: trader.maxDrawdown,
      currentDrawdown: null,
      volatility: null,
      copiersCount: null,
      copiersPnl: null,
      aum: trader.aum,
      // Phase 3: Save winning positions count
      winningPositions: trader.totalWins,
      totalPositions: trader.tradesCount,
    }
    const { saved } = await upsertStatsDetail(supabase, SOURCE, trader.address, period, stats)
    if (saved) statsSaved++
  }
  logger.warn(`[${SOURCE}] Saved ${statsSaved} stats details for ${period}`)

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = topTraders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://app.hyperliquid.xyz/@${t.address}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    aum: t.aum, // Phase 1: 保存 AUM
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    trades_count: t.tradesCount, // Phase 1: 保存交易数
    arena_score: calculateArenaScore(t.roi, t.pnl, t.maxDrawdown, t.winRate, period),
    captured_at: capturedAt,
  }))

  const { saved, error } = await upsertTraders(supabase, traders)
  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchHyperliquid(
  supabase: SupabaseClient,
  periods: string[]
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = { source: SOURCE, periods: {}, duration: 0 }

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

  result.duration = Date.now() - start
  return result
}
