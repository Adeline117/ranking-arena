/**
 * Leaderboard Discovery Script
 * Fetches the top traders from the leaderboard and writes snapshots + profiles.
 * Designed to be run periodically via cron or manually.
 *
 * Usage:
 *   npx tsx worker/src/job-runner/discover-leaderboard.ts [platform] [window] [limit]
 *
 * Examples:
 *   npx tsx worker/src/job-runner/discover-leaderboard.ts binance_futures 90D 100
 *   npx tsx worker/src/job-runner/discover-leaderboard.ts  # defaults: binance_futures, all windows, 100
 *
 * Environment:
 *   SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 */

import { createClient } from '@supabase/supabase-js'
import { BinanceFuturesConnectorWorker } from './binance-connector.js'
import { BybitFuturesConnectorWorker } from './bybit-connector.js'
import type { SnapshotWindow } from './types.js'
import { logger } from '../logger.js'

const WINDOWS: SnapshotWindow[] = ['7D', '30D', '90D']

async function main(): Promise<void> {
  const platform = process.argv[2] || 'binance_futures'
  const targetWindow = process.argv[3] as SnapshotWindow | undefined
  const limit = parseInt(process.argv[4] || '100')

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) {
    throw new Error('Missing SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  }
  const db = createClient(url, serviceKey, { auth: { persistSession: false } })

  const windows = targetWindow ? [targetWindow] : WINDOWS

  logger.info(`[discover] Starting leaderboard discovery: platform=${platform}, windows=${windows.join(',')}, limit=${limit}`)

  for (const window of windows) {
    logger.info(`[discover] Fetching ${window} leaderboard...`)

    // Fetch leaderboard entries using the appropriate connector
    const leaderboard = platform === 'bybit'
      ? await fetchBybitLeaderboard(window, limit)
      : await fetchLeaderboard(window, limit)

    if (leaderboard.length === 0) {
      logger.info(`[discover] No data for ${window}, skipping`)
      continue
    }

    logger.info(`[discover] Got ${leaderboard.length} traders for ${window}`)

    // Batch upsert profiles
    let profilesUpserted = 0
    for (const entry of leaderboard) {
      const { error } = await db
        .from('trader_profiles')
        .upsert({
          platform,
          trader_key: entry.trader_key,
          display_name: entry.display_name,
          avatar_url: entry.avatar_url,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'platform,trader_key' })

      if (!error) profilesUpserted++
    }
    logger.info(`[discover] Upserted ${profilesUpserted} profiles`)

    // Batch insert snapshots
    const now = new Date().toISOString()
    let snapshotsInserted = 0
    let snapshotsSkipped = 0

    for (const entry of leaderboard) {
      const { error } = await db
        .from('trader_snapshots_v2')
        .insert({
          platform,
          trader_key: entry.trader_key,
          window,
          as_of_ts: now,
          metrics: entry.metrics,
          quality_flags: entry.quality_flags,
          updated_at: now,
        })

      if (error) {
        if (error.code === '23505') {
          snapshotsSkipped++ // Duplicate in same hourly bucket
        } else {
          logger.error(`[discover] Snapshot insert error for ${entry.trader_key}`, new Error(error.message), { trader_key: entry.trader_key })
        }
      } else {
        snapshotsInserted++
      }
    }

    logger.info(`[discover] ${window}: inserted=${snapshotsInserted}, skipped=${snapshotsSkipped}`)

    // Also update trader_sources for discovery tracking
    for (const entry of leaderboard) {
      await db
        .from('trader_sources')
        .upsert({
          source: platform,
          source_trader_id: entry.trader_key,
          platform,
          trader_key: entry.trader_key,
          handle: entry.display_name,
          avatar_url: entry.avatar_url,
          profile_url: entry.avatar_url,
          type: 'leaderboard',
          last_seen_at: now,
          is_active: true,
        }, { onConflict: 'source,source_trader_id' })
    }
  }

  logger.info('[discover] Done!')
}

interface LeaderboardResult {
  trader_key: string
  display_name: string | null
  avatar_url: string | null
  metrics: Record<string, unknown>
  quality_flags: Record<string, unknown>
}

async function fetchBybitLeaderboard(
  window: SnapshotWindow,
  limit: number
): Promise<LeaderboardResult[]> {
  const connector = new BybitFuturesConnectorWorker()
  return connector.fetchLeaderboardList(window, limit)
}

async function fetchLeaderboard(
  window: SnapshotWindow,
  limit: number
): Promise<LeaderboardResult[]> {
  // For the leaderboard discovery we use the connector's internal API
  // to get bulk data without hitting individual trader endpoints
  const results: LeaderboardResult[] = []

  const BINANCE_API_V1 = 'https://www.binance.com/bapi/futures/v1/friendly/future/copy-trade'
  const WINDOW_TO_PERIOD: Record<SnapshotWindow, string> = {
    '7D': 'WEEKLY',
    '30D': 'MONTHLY',
    '90D': 'QUARTERLY',
  }
  const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ]

  const pageSize = 20
  const maxPages = Math.ceil(limit / pageSize)

  for (let page = 1; page <= maxPages && results.length < limit; page++) {
    // Rate limit
    await new Promise(r => setTimeout(r, 2500 + Math.random() * 500))

    try {
      const response = await fetch(`${BINANCE_API_V1}/home-page/query-list`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': USER_AGENTS[0],
          'Accept': 'application/json',
          'Origin': 'https://www.binance.com',
          'Referer': 'https://www.binance.com/en/copy-trading',
        },
        body: JSON.stringify({
          pageNumber: page,
          pageSize,
          timeRange: WINDOW_TO_PERIOD[window],
          dataType: 'ROI',
          favoriteOnly: false,
        }),
      })

      if (!response.ok) {
        logger.error(`[discover] API error page ${page}: ${response.status}`, new Error(`HTTP ${response.status}`), { page })
        break
      }

      const json = await response.json() as Record<string, unknown>
      const data = json.data as Record<string, unknown> | undefined
      const list = (data?.list || data?.data || []) as Array<Record<string, unknown>>

      if (!Array.isArray(list) || list.length === 0) break

      for (const item of list) {
        const traderId = item.portfolioId || item.leadPortfolioId || item.encryptedUid
        if (!traderId) continue

        const roi = parseNum(item.roi ?? item.roiValue)
        const pnl = parseNum(item.pnl ?? item.totalPnl)
        const winRate = parseNum(item.winRate)
        const maxDrawdown = parseNum(item.maxDrawdown ?? item.mdd)

        const normalizedWinRate = winRate != null ? (winRate <= 1 ? winRate * 100 : winRate) : null

        // Simple arena score calculation
        const arenaScore = calculateSimpleScore(roi ?? 0, pnl ?? 0, maxDrawdown, normalizedWinRate, window)

        results.push({
          trader_key: String(traderId),
          display_name: (item.nickName || item.nickname || null) as string | null,
          avatar_url: (item.userPhotoUrl || item.avatar || null) as string | null,
          metrics: {
            roi: roi ?? 0,
            pnl: pnl ?? 0,
            win_rate: normalizedWinRate,
            max_drawdown: maxDrawdown != null ? Math.abs(maxDrawdown) : null,
            trades_count: (item.tradeCount ?? item.totalTradeCount ?? null) as number | null,
            followers: (item.followerCount ?? null) as number | null,
            aum: item.totalAssets ? parseFloat(String(item.totalAssets)) : null,
            arena_score: arenaScore.total,
            return_score: arenaScore.returnScore,
            drawdown_score: arenaScore.drawdownScore,
            stability_score: arenaScore.stabilityScore,
            rank: results.length + 1,
          },
          quality_flags: {
            is_suspicious: false,
            suspicion_reasons: [],
            data_completeness: [roi != null, pnl != null, winRate != null, maxDrawdown != null].filter(Boolean).length / 4,
          },
        })
      }
    } catch (err) {
      logger.error(`[discover] Fetch error page ${page}`, err instanceof Error ? err : new Error(String(err)), { page })
      break
    }
  }

  return results.slice(0, limit)
}

function parseNum(value: unknown): number | null {
  if (value == null) return null
  const n = typeof value === 'string' ? parseFloat(value) : Number(value)
  return isNaN(n) ? null : n
}

function calculateSimpleScore(
  roi: number,
  pnl: number,
  maxDrawdown: number | null,
  winRate: number | null,
  window: SnapshotWindow
): { total: number; returnScore: number; drawdownScore: number; stabilityScore: number } {
  const thresholds: Record<SnapshotWindow, number> = { '7D': 50, '30D': 200, '90D': 500 }
  if (Math.abs(pnl) < thresholds[window]) {
    return { total: 0, returnScore: 0, drawdownScore: 0, stabilityScore: 0 }
  }

  let returnScore: number
  if (roi <= 0) returnScore = 0
  else if (roi < 50) returnScore = (roi / 50) * 30
  else if (roi < 200) returnScore = 30 + ((roi - 50) / 150) * 25
  else if (roi < 1000) returnScore = 55 + ((roi - 200) / 800) * 20
  else returnScore = 75 + Math.min((roi - 1000) / 5000, 1) * 10
  returnScore = Math.min(returnScore, 85)

  const mdd = Math.abs(maxDrawdown ?? 100)
  let drawdownScore: number
  if (mdd <= 5) drawdownScore = 8
  else if (mdd <= 10) drawdownScore = 7
  else if (mdd <= 20) drawdownScore = 5
  else if (mdd <= 40) drawdownScore = 3
  else if (mdd <= 60) drawdownScore = 1
  else drawdownScore = 0

  const wr = winRate ?? 50
  let stabilityScore: number
  if (wr >= 80) stabilityScore = 7
  else if (wr >= 70) stabilityScore = 6
  else if (wr >= 60) stabilityScore = 5
  else if (wr >= 50) stabilityScore = 3
  else if (wr >= 40) stabilityScore = 2
  else stabilityScore = 0

  const total = Math.round((returnScore + drawdownScore + stabilityScore) * 100) / 100
  return { total, returnScore, drawdownScore, stabilityScore }
}

main().catch(err => {
  logger.error('Fatal error in discover-leaderboard', err instanceof Error ? err : new Error(String(err)))
  process.exit(1)
})
