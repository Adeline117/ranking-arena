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
} from './shared'

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

// ── Win rate enrichment ──

async function fetchWinRate(
  address: string,
  period: string
): Promise<number | null> {
  try {
    const days = WINDOW_DAYS[period] || 30
    const startTime = Date.now() - days * 24 * 60 * 60 * 1000

    const fills = await fetchJson<FillEntry[]>(INFO_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { type: 'userFillsByTime', user: address, startTime, aggregateByTime: true },
      timeoutMs: 8000,
    })

    if (!Array.isArray(fills) || fills.length === 0) return null

    const closed = fills.filter((f) => {
      const pnl = parseFloat(f.closedPnl || '0')
      return pnl !== 0
    })
    if (closed.length === 0) return null

    const wins = closed.filter((f) => parseFloat(f.closedPnl || '0') > 0)
    return (wins.length / closed.length) * 100
  } catch {
    return null
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
  winRate: number | null
  maxDrawdown: number | null
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
        const [winRate, maxDrawdown] = await Promise.all([
          fetchWinRate(trader.address, period),
          fetchMaxDrawdown(trader.address, period),
        ])
        trader.winRate = winRate
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
      winRate: null,
      maxDrawdown: null,
    })
  }

  // Sort by ROI and take top TARGET
  parsed.sort((a, b) => b.roi - a.roi)
  const topTraders = parsed.slice(0, TARGET)

  // Enrich with win rate + MDD (limited for serverless)
  await enrichTraders(topTraders, period)

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
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
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
