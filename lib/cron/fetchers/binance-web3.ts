/**
 * Binance Web3 Wallet Leaderboard — Inline fetcher for Vercel serverless
 *
 * Source page: https://web3.binance.com/en/leaderboard
 *
 * API: web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query
 * - GET request, query params: chainId, period, tag, pageNo, pageSize (max 25)
 * - Returns on-chain wallet PnL data (BSC, Base, Solana)
 * - No geo-blocking on this endpoint (works globally)
 *
 * Field mappings:
 *  - address: wallet address (0x...)
 *  - addressLabel: display name
 *  - realizedPnl: absolute PnL in USD
 *  - realizedPnlPercent: decimal ROI (0.27 = 27%)
 *  - winRate: decimal (0.65 = 65%)
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
} from './shared'
import { type StatsDetail, upsertStatsDetail } from './enrichment'
import { logger } from '@/lib/logger'
import { captureException } from '@/lib/utils/logger'

const SOURCE = 'binance_web3'
const TARGET = 500
const PAGE_SIZE = 25 // API max

// Binance Web3 Wallet on-chain leaderboard (no geo-blocking)
const WEB3_LEADERBOARD_URL =
  'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/market/leaderboard/query'

const WEB3_PERIOD_MAP: Record<string, string> = {
  '7D': '7d',
  '30D': '30d',
  '90D': '90d',
}

// Chain IDs to query (BSC, Base, Solana)
const CHAIN_IDS = ['56', '8453', 'CT_501']

// ── Types ──

interface Web3LeaderboardEntry {
  address: string
  addressLabel?: string
  addressLogo?: string
  realizedPnl?: string
  realizedPnlPercent?: string
  winRate?: string
  txCount?: number
  balance?: string
  tags?: string[]
}

interface Web3Response {
  code?: string
  data?: {
    data?: Web3LeaderboardEntry[]
    total?: number
  }
}

// ── Fetch helpers ──

async function fetchWeb3Leaderboard(
  period: string
): Promise<TraderData[]> {
  const web3Period = WEB3_PERIOD_MAP[period] || '30d'
  const allTraders = new Map<string, TraderData>()
  const capturedAt = new Date().toISOString()

  for (const chainId of CHAIN_IDS) {
    const maxPages = Math.ceil(TARGET / PAGE_SIZE / CHAIN_IDS.length)

    for (let page = 1; page <= maxPages; page++) {
      try {
        const url = `${WEB3_LEADERBOARD_URL}?chainId=${chainId}&period=${web3Period}&tag=ALL&pageNo=${page}&pageSize=${PAGE_SIZE}`

        const data = await fetchJson<Web3Response>(url, {
          headers: {
            'Origin': 'https://web3.binance.com',
            'Referer': 'https://web3.binance.com/',
            'Accept-Encoding': 'gzip, deflate, br',
          },
          timeoutMs: 15000,
        })

        const entries = data?.data?.data
        if (!entries?.length) break

        for (const entry of entries) {
          if (!entry.address || allTraders.has(entry.address)) continue

          // ROI is decimal (0.27 = 27%)
          const roiDecimal = parseNum(entry.realizedPnlPercent)
          if (roiDecimal == null) continue
          const roi = roiDecimal * 100

          const pnl = parseNum(entry.realizedPnl)
          const winRateDecimal = parseNum(entry.winRate)
          const winRate = winRateDecimal != null ? winRateDecimal * 100 : null

          allTraders.set(entry.address, {
            source: SOURCE,
            source_trader_id: entry.address,
            handle: entry.addressLabel || `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}`,
            profile_url: `https://web3.binance.com/en/leaderboard/detail/${entry.address}`,
            season_id: period,
            roi,
            pnl,
            win_rate: winRate,
            max_drawdown: null,
            followers: null,
            avatar_url: entry.addressLogo || null,
            arena_score: calculateArenaScore(roi, pnl, null, winRate, period),
            captured_at: capturedAt,
          })
        }

        if (entries.length < PAGE_SIZE) break
        await sleep(300)
      } catch (err) {
        logger.warn(`[${SOURCE}] Chain ${chainId} page ${page} failed: ${err instanceof Error ? err.message : String(err)}`)
        break
      }
    }

    if (allTraders.size >= TARGET) break
    await sleep(500)
  }

  return Array.from(allTraders.values())
}

// ── Period fetcher ──

async function fetchPeriod(
  supabase: SupabaseClient,
  period: string
): Promise<{ total: number; saved: number; error?: string }> {
  const traders = await fetchWeb3Leaderboard(period)

  if (traders.length === 0) {
    return { total: 0, saved: 0, error: 'No data from Binance Web3 wallet leaderboard' }
  }

  // Sort by ROI and assign ranks
  traders.sort((a, b) => (b.roi ?? 0) - (a.roi ?? 0))
  const top = traders.slice(0, TARGET)
  top.forEach((t, idx) => { t.rank = idx + 1 })

  const { saved, error } = await upsertTraders(supabase, top)

  // Save stats_detail for 90D period
  if (saved > 0 && period === '90D') {
    let statsSaved = 0
    for (const trader of top.slice(0, 50)) {
      const stats: StatsDetail = {
        totalTrades: null,
        profitableTradesPct: trader.win_rate ?? null,
        avgHoldingTimeHours: null, avgProfit: null, avgLoss: null,
        largestWin: null, largestLoss: null, sharpeRatio: null,
        maxDrawdown: null, currentDrawdown: null, volatility: null,
        copiersCount: null, copiersPnl: null, aum: null,
        winningPositions: null, totalPositions: null,
      }
      const { saved: s } = await upsertStatsDetail(supabase, SOURCE, trader.source_trader_id, period, stats)
      if (s) statsSaved++
    }
    logger.info(`[${SOURCE}] Saved ${statsSaved} stats details`)
  }

  return { total: top.length, saved, error }
}

// ── Export ──

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
