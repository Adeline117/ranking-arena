/**
 * Perpetual Protocol v2 (Optimism) — Inline fetcher for Vercel serverless
 * API: The Graph subgraph for Perp v2 on Optimism
 * Uses trader account data from subgraph for leaderboard
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  type FetchResult,
  type TraderData,
  calculateArenaScore,
  upsertTraders,
  fetchJson,
  sleep,
} from '../shared'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'perpetual_protocol'
const SUBGRAPH_URL =
  'https://api.studio.thegraph.com/query/58978/perpetual-v2-optimism/version/latest'
const TARGET = 300
const CONCURRENCY = 5
const DELAY_MS = 200

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// ── GraphQL helpers ──

interface TraderAccount {
  id: string // wallet address
  totalPnl: string
  totalFee: string
  tradingVolume: string
  totalPositionSize: string
  blockNumberLogIndex: string
}

interface TraderDayData {
  date: number // unix timestamp (day)
  realizedPnl: string
  tradingVolume: string
  fee: string
}

async function graphqlQuery<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  return fetchJson<T>(SUBGRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { query, variables },
    timeoutMs: 25000,
  })
}

function toNum(val: string | undefined | null): number {
  if (!val) return 0
  return parseFloat(val) || 0
}

// ── Fetch leaderboard data ──

async function fetchLeaderboard(windowDays: number): Promise<TraderData[]> {
  const cutoff = Math.floor(Date.now() / 1000) - windowDays * 86400
  const now = new Date().toISOString()

  // Fetch top traders by volume in the window
  // We use traderDayDatas aggregated within the window
  const batchSize = 100
  let skip = 0
  const traderPnlMap = new Map<string, { pnl: number; volume: number; fee: number; days: number }>()

  while (traderPnlMap.size < TARGET && skip < 2000) {
    const query = `{
      traderDayDatas(
        first: ${batchSize}
        skip: ${skip}
        where: { date_gte: ${cutoff} }
        orderBy: tradingVolume
        orderDirection: desc
      ) {
        trader { id }
        date
        realizedPnl
        tradingVolume
        fee
      }
    }`

    type DayDataResult = {
      data?: {
        traderDayDatas?: Array<{
          trader: { id: string }
          date: number
          realizedPnl: string
          tradingVolume: string
          fee: string
        }>
      }
    }

    const result = await graphqlQuery<DayDataResult>(query)
    const dayDatas = result?.data?.traderDayDatas || []

    if (dayDatas.length === 0) break

    for (const dd of dayDatas) {
      const addr = dd.trader.id.toLowerCase()
      const prev = traderPnlMap.get(addr) || { pnl: 0, volume: 0, fee: 0, days: 0 }
      traderPnlMap.set(addr, {
        pnl: prev.pnl + toNum(dd.realizedPnl),
        volume: prev.volume + toNum(dd.tradingVolume),
        fee: prev.fee + toNum(dd.fee),
        days: prev.days + 1,
      })
    }

    skip += batchSize
    if (dayDatas.length < batchSize) break
    await sleep(DELAY_MS)
  }

  if (traderPnlMap.size === 0) return []

  // Also fetch total account stats for the traders we found
  const traderAddrs = Array.from(traderPnlMap.keys()).slice(0, TARGET)

  // Fetch account stats in batches of 50
  const accountMap = new Map<string, { totalPnl: number; volume: number }>()
  for (let i = 0; i < traderAddrs.length; i += 50) {
    const batch = traderAddrs.slice(i, i + 50)
    const idsStr = batch.map(a => `"${a}"`).join(',')

    const accountQuery = `{
      traders(where: { id_in: [${idsStr}] }) {
        id
        totalPnl
        tradingVolume
      }
    }`

    type AccountResult = {
      data?: {
        traders?: Array<{
          id: string
          totalPnl: string
          tradingVolume: string
        }>
      }
    }

    try {
      const result = await graphqlQuery<AccountResult>(accountQuery)
      for (const acc of result?.data?.traders || []) {
        accountMap.set(acc.id.toLowerCase(), {
          totalPnl: toNum(acc.totalPnl),
          volume: toNum(acc.tradingVolume),
        })
      }
    } catch {
      // Continue with day data only
    }
    await sleep(DELAY_MS)
  }

  // Build trader data sorted by PnL
  const seasonId = windowDays === 7 ? '7D' : windowDays === 30 ? '30D' : '90D'

  const traders: Array<TraderData & { rawPnl: number }> = []

  for (const [addr, stats] of traderPnlMap) {
    const netPnl = stats.pnl - stats.fee // PnL after fees
    const account = accountMap.get(addr)
    const totalVolume = account?.volume || stats.volume

    // Estimate ROI: PnL / estimated capital (volume / avg leverage ~5x)
    const estimatedCapital = totalVolume > 0 ? totalVolume / 5 : 1
    const roi = estimatedCapital > 0 ? (netPnl / estimatedCapital) * 100 : 0

    // Win rate approximation based on day data
    const winRate = stats.days > 0
      ? Math.min(100, Math.max(0, 50 + (netPnl > 0 ? 10 : -10))) // Rough estimate
      : null

    const arenaScore = calculateArenaScore(roi, netPnl, null, winRate, seasonId)

    traders.push({
      source: SOURCE,
      source_trader_id: addr,
      handle: `${addr.slice(0, 6)}...${addr.slice(-4)}`,
      profile_url: `https://optimistic.etherscan.io/address/${addr}`,
      season_id: seasonId,
      roi,
      pnl: netPnl,
      win_rate: winRate,
      max_drawdown: null,
      followers: null,
      trades_count: stats.days,
      arena_score: arenaScore,
      captured_at: now,
      rawPnl: netPnl,
    })
  }

  // Sort by PnL descending, assign ranks
  traders.sort((a, b) => b.rawPnl - a.rawPnl)
  return traders.slice(0, TARGET).map((t, i) => {
    const { rawPnl: _, ...trader } = t
    return { ...trader, rank: i + 1 }
  })
}

// ── Main fetcher ──

export default async function fetchPerpetualProtocol(
  supabase: SupabaseClient,
  periods: string[] = ['7D', '30D']
): Promise<FetchResult> {
  const start = Date.now()
  const result: FetchResult = {
    source: SOURCE,
    periods: {},
    duration: 0,
  }

  for (const period of periods) {
    const days = WINDOW_DAYS[period]
    if (!days) {
      result.periods[period] = { total: 0, saved: 0, error: `Unknown period: ${period}` }
      continue
    }

    try {
      const traders = await fetchLeaderboard(days)
      result.periods[period] = { total: traders.length, saved: 0 }

      if (traders.length > 0) {
        const { saved, error } = await upsertTraders(supabase, traders)
        result.periods[period].saved = saved
        if (error) result.periods[period].error = error
      }

      logger.info(
        `[${SOURCE}] ${period}: ${traders.length} traders fetched, ${result.periods[period].saved} saved`
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      result.periods[period] = { total: 0, saved: 0, error: msg }
      logger.error(`[${SOURCE}] ${period} failed:`, error)
      captureException(error instanceof Error ? error : new Error(msg))
    }
  }

  result.duration = Date.now() - start
  return result
}
