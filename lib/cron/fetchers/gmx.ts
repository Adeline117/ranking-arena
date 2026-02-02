/**
 * GMX (Arbitrum) — Inline fetcher for Vercel serverless
 * API: Subsquid GraphQL https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql
 * accountStats for leaderboard, positionChanges for MDD enrichment
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

const SOURCE = 'gmx'
const SUBSQUID_URL =
  'https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql'
const TARGET = 500
const ENRICH_LIMIT = 100 // Limit MDD enrichment for serverless
const CONCURRENCY = 3
const DELAY_MS = 300
const VALUE_SCALE = 1e30

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// ── GraphQL helpers ──

interface AccountStat {
  id: string
  wins?: number
  losses?: number
  realizedPnl?: string
  volume?: string
  netCapital?: string
  maxCapital?: string
  closedCount?: number
}

interface PositionChange {
  timestamp: number
  basePnlUsd?: string
  sizeDeltaUsd?: string
}

async function graphqlQuery<T>(query: string): Promise<T> {
  return fetchJson<T>(SUBSQUID_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { query },
    timeoutMs: 20000,
  })
}

/**
 * Convert BigInt-encoded string / VALUE_SCALE to a number.
 * Uses BigInt to avoid floating-point overflow for very large values.
 */
function bigToNum(val: string | undefined | null): number {
  if (!val) return 0
  try {
    return Number(BigInt(val)) / VALUE_SCALE
  } catch {
    return parseFloat(val) / VALUE_SCALE || 0
  }
}

// ── MDD enrichment via positionChanges ──

async function fetchMaxDrawdown(
  originalAddress: string,
  period: string
): Promise<number | null> {
  try {
    const days = WINDOW_DAYS[period] || 90
    const windowStart = Math.floor(
      (Date.now() - days * 24 * 60 * 60 * 1000) / 1000
    )

    // GMX GraphQL is case-sensitive — use original casing
    const query = `{
      positionChanges(
        where: {
          account_eq: "${originalAddress}"
          timestamp_gte: ${windowStart}
        }
        orderBy: timestamp_ASC
        limit: 500
      ) {
        timestamp
        basePnlUsd
        sizeDeltaUsd
      }
    }`

    let result = await graphqlQuery<{
      data?: { positionChanges?: PositionChange[] }
    }>(query)

    let changes = result?.data?.positionChanges

    // Fallback: for 90D, try without time filter
    if ((!changes || changes.length < 2) && period === '90D') {
      const fallbackQuery = `{
        positionChanges(
          where: { account_eq: "${originalAddress}" }
          orderBy: timestamp_ASC
          limit: 500
        ) {
          timestamp
          basePnlUsd
          sizeDeltaUsd
        }
      }`
      result = await graphqlQuery(fallbackQuery)
      changes = result?.data?.positionChanges
    }

    if (!changes || changes.length < 2) return null

    // Filter to closing changes (non-zero basePnlUsd)
    const closing = changes.filter((c) => {
      const pnl = c.basePnlUsd ? bigToNum(c.basePnlUsd) * VALUE_SCALE : 0
      // Re-scale — basePnlUsd is already in the raw BigInt space
      return c.basePnlUsd ? Number(BigInt(c.basePnlUsd)) / VALUE_SCALE !== 0 : false
    })

    if (closing.length < 2) return null

    // Cumulative equity curve for MDD
    let cumulativePnl = 0
    let peakEquity = 0
    let maxDD = 0

    for (const change of closing) {
      const pnl = bigToNum(change.basePnlUsd)
      cumulativePnl += pnl

      if (cumulativePnl > peakEquity) peakEquity = cumulativePnl
      if (peakEquity > 0) {
        const dd = ((peakEquity - cumulativePnl) / peakEquity) * 100
        if (dd > maxDD) maxDD = dd
      }
    }

    return maxDD > 0 && maxDD < 200 ? maxDD : null
  } catch {
    return null
  }
}

// ── Per-period fetch ──

interface ParsedGmxTrader {
  address: string
  originalAddress: string
  displayName: string
  roi: number
  pnl: number
  winRate: number | null
  maxDrawdown: number | null
  tradesCount: number
}

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  // Fetch leaderboard via accountStats
  const query = `{
    accountStats(
      limit: ${TARGET * 2},
      orderBy: realizedPnl_DESC
    ) {
      id
      wins
      losses
      realizedPnl
      volume
      netCapital
      maxCapital
      closedCount
    }
  }`

  const result = await graphqlQuery<{
    data?: { accountStats?: AccountStat[] }
  }>(query)

  const stats = result?.data?.accountStats
  if (!stats?.length) {
    return { total: 0, saved: 0, error: 'No accountStats data' }
  }

  // Parse traders
  const parsed: ParsedGmxTrader[] = []

  for (const item of stats) {
    const pnl = bigToNum(item.realizedPnl)
    const maxCapital = bigToNum(item.maxCapital)
    const roi = maxCapital > 100 ? (pnl / maxCapital) * 100 : 0
    const totalTrades = (item.wins || 0) + (item.losses || 0)
    const winRate =
      totalTrades > 0 ? ((item.wins || 0) / totalTrades) * 100 : null

    // Sanity bounds
    if (roi < -100 || roi > 10000) continue
    if (pnl < -10000000 || pnl > 100000000) continue

    parsed.push({
      address: item.id.toLowerCase(),
      originalAddress: item.id, // Preserve case for GraphQL queries
      displayName: `${item.id.slice(0, 6)}...${item.id.slice(-4)}`,
      roi,
      pnl,
      winRate,
      maxDrawdown: null,
      tradesCount: item.closedCount || totalTrades,
    })
  }

  parsed.sort((a, b) => b.roi - a.roi)
  const topTraders = parsed.slice(0, TARGET)

  // Enrich top traders with MDD (limited for serverless)
  const toEnrich = topTraders.slice(0, ENRICH_LIMIT)
  for (let i = 0; i < toEnrich.length; i += CONCURRENCY) {
    const batch = toEnrich.slice(i, i + CONCURRENCY)
    await Promise.all(
      batch.map(async (trader) => {
        trader.maxDrawdown = await fetchMaxDrawdown(
          trader.originalAddress,
          period
        )
      })
    )
    await sleep(DELAY_MS)
  }

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = topTraders.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.address,
    handle: t.displayName,
    profile_url: `https://app.gmx.io/#/actions/${t.address}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate,
    max_drawdown: t.maxDrawdown,
    trades_count: t.tradesCount,
    arena_score: calculateArenaScore(
      t.roi,
      t.pnl,
      t.maxDrawdown,
      t.winRate,
      period
    ),
    captured_at: capturedAt,
  }))

  const { saved, error } = await upsertTraders(supabase, traders)
  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchGmx(
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
