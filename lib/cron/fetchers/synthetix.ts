/**
 * Synthetix V3 Perps (Base) — Inline fetcher for Vercel serverless
 * API: The Graph decentralized network (requires THEGRAPH_API_KEY)
 *
 * Synthetix V3 perps are deployed on Base and Optimism, powering Kwenta and other frontends.
 * This fetcher queries the Synthetix perps subgraph for account-level data.
 *
 * Subgraph: Uses the Synthetix perps market subgraph on Base.
 * The subgraph ID may need updating as Synthetix deploys new versions.
 *
 * Schema fields: accounts with positions, realized PnL, collateral, and trade counts.
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
import { type StatsDetail, upsertStatsDetail } from './enrichment'

const SOURCE = 'synthetix'
const TARGET = 500

// Synthetix Perps V3 subgraph on Base
// This subgraph indexes Synthetix V3 perps market on Base chain
const SUBGRAPH_ID = 'Cjhmx65d3EJPxYXcidLeBXFGiVrBfYEPaywVMPf3DP9M'

const WINDOW_DAYS: Record<string, number> = { '7D': 7, '30D': 30, '90D': 90 }

// ── API response types ──

interface SynthetixPosition {
  id: string
  timestamp?: string
  timestampClosed?: string
  size?: string
  collateral?: string
  realizedPnl?: string
  pnl?: string
  entryPrice?: string
  exitPrice?: string
  isOpen?: boolean
}

interface SynthetixAccount {
  id: string
  owner?: string
  totalVolume?: string
  totalPnl?: string
  totalTrades?: number
  positions?: SynthetixPosition[]
  cumulativeClosedPositionCount?: number
}

interface GraphQLResponse {
  data?: {
    accounts?: SynthetixAccount[]
    positions?: SynthetixPosition[]
  }
  errors?: Array<{ message: string }>
}

// ── Helpers ──

function getSubgraphUrl(): string | null {
  const apiKey = process.env.THEGRAPH_API_KEY || ''
  if (!apiKey) return null
  return `https://gateway-arbitrum.network.thegraph.com/api/${apiKey}/subgraphs/id/${SUBGRAPH_ID}`
}

function toNum(v: string | undefined | null): number {
  if (!v) return 0
  const n = parseFloat(v)
  return isNaN(n) ? 0 : n
}

// ── Per-period fetch — accounts with aggregate stats ──

async function fetchAccountsWithStats(
  subgraphUrl: string,
  period: string
): Promise<SynthetixAccount[]> {
  // Try accounts-based query first (V3 schema)
  const query = `
    query GetTopAccounts {
      accounts(
        first: ${TARGET * 2}
        orderBy: totalVolume
        orderDirection: desc
      ) {
        id
        owner
        totalVolume
        totalPnl
        totalTrades
      }
    }
  `

  try {
    const json = await fetchJson<GraphQLResponse>(subgraphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { query },
      timeoutMs: 30000,
    })

    if (json.data?.accounts?.length) return json.data.accounts
  } catch {
    // Try fallback schema
  }

  // Fallback: Messari standard schema (similar to Kwenta/MUX)
  const fallbackQuery = `
    query GetTopTraders {
      accounts(
        first: ${TARGET}
        orderBy: cumulativeClosedPositionCount
        orderDirection: desc
        where: { cumulativeClosedPositionCount_gt: 0 }
      ) {
        id
        cumulativeClosedPositionCount
        positions(first: 100, orderBy: timestampClosed, orderDirection: desc) {
          id
          timestampClosed
          collateral
          realizedPnl
          pnl
        }
      }
    }
  `

  const json = await fetchJson<GraphQLResponse>(subgraphUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { query: fallbackQuery },
    timeoutMs: 30000,
  })

  return json.data?.accounts || []
}

// ── Per-period fetch ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const subgraphUrl = getSubgraphUrl()
  if (!subgraphUrl) {
    return { total: 0, saved: 0, error: 'Missing THEGRAPH_API_KEY env var' }
  }

  let accounts: SynthetixAccount[]
  try {
    accounts = await fetchAccountsWithStats(subgraphUrl, period)
  } catch (err) {
    return {
      total: 0,
      saved: 0,
      error: `Subgraph query failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (accounts.length === 0) {
    return { total: 0, saved: 0, error: 'No accounts returned from Synthetix subgraph' }
  }

  const days = WINDOW_DAYS[period] || 90
  const windowStart = Math.floor(
    (Date.now() - days * 24 * 60 * 60 * 1000) / 1000
  )

  interface ParsedTrader {
    id: string
    owner: string
    roi: number
    pnl: number
    winRate: number | null
    tradesCount: number
  }

  const parsed: ParsedTrader[] = []

  for (const account of accounts) {
    const owner = (account.owner || account.id).toLowerCase()

    // If the account has aggregate stats (V3 schema)
    if (account.totalPnl != null) {
      const pnl = toNum(account.totalPnl)
      const volume = toNum(account.totalVolume)
      const trades = account.totalTrades || 0

      // Estimate ROI: approximate capital as volume / avg_leverage
      const estimatedCapital = volume > 0 ? volume / 10 : 0
      const roi = estimatedCapital > 100 ? (pnl / estimatedCapital) * 100 : 0

      if (roi === 0 && pnl === 0) continue
      if (roi < -100 || roi > 10000) continue

      parsed.push({
        id: account.id,
        owner,
        roi,
        pnl,
        winRate: null,
        tradesCount: trades,
      })
      continue
    }

    // Fallback: Messari schema with positions
    const positions = (account.positions || []).filter(
      (p) => p.timestampClosed && parseInt(p.timestampClosed) >= windowStart
    )
    if (positions.length === 0) continue

    let totalPnl = 0
    let totalCollateral = 0
    let wins = 0

    for (const pos of positions) {
      const pnl = toNum(pos.realizedPnl || pos.pnl)
      const collateral = toNum(pos.collateral)
      totalPnl += pnl
      totalCollateral += collateral
      if (pnl > 0) wins++
    }

    const roi = totalCollateral > 0 ? (totalPnl / totalCollateral) * 100 : 0
    if (roi === 0) continue

    const winRate =
      positions.length > 0 ? (wins / positions.length) * 100 : null

    parsed.push({
      id: account.id,
      owner,
      roi,
      pnl: totalPnl,
      winRate,
      tradesCount: positions.length,
    })
  }

  parsed.sort((a, b) => b.roi - a.roi)
  const top = parsed.slice(0, TARGET)

  const capturedAt = new Date().toISOString()
  const traders: TraderData[] = top.map((t, idx) => ({
    source: SOURCE,
    source_trader_id: t.owner,
    handle: `${t.owner.slice(0, 6)}...${t.owner.slice(-4)}`,
    profile_url: `https://v3.synthetix.io/dashboard/perps/${t.owner}`,
    season_id: period,
    rank: idx + 1,
    roi: t.roi,
    pnl: t.pnl || null,
    win_rate: t.winRate,
    max_drawdown: null,
    trades_count: t.tradesCount,
    arena_score: calculateArenaScore(t.roi, t.pnl, null, t.winRate, period),
    captured_at: capturedAt,
  }))

  const { saved, error } = await upsertTraders(supabase, traders)

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    console.warn(`[${SOURCE}] Saving stats details for top ${Math.min(top.length, 50)} traders...`)
    let statsSaved = 0
    for (const t of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: t.tradesCount,
        profitableTradesPct: t.winRate,
        avgHoldingTimeHours: null,
        avgProfit: null,
        avgLoss: null,
        largestWin: null,
        largestLoss: null,
        sharpeRatio: null,
        maxDrawdown: null,
        currentDrawdown: null,
        volatility: null,
        copiersCount: null,
        copiersPnl: null,
        aum: null,
        winningPositions: null,
        totalPositions: t.tradesCount,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, t.owner, period, stats)
      if (s) statsSaved++
    }
    console.warn(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: traders.length, saved, error }
}

// ── Exported entry point ──

export async function fetchSynthetix(
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
