/**
 * Job scheduler — replaces vercel.json cron entries.
 *
 * Uses BullMQ's upsertJobScheduler for repeatable jobs.
 * Each platform gets its own independent fetch job on a schedule.
 */

import { getQueue, JOB, type FetchPlatformData, type ComputeLeaderboardData } from './queues'

// ── Platform schedules ──
// Frequency based on data update speed and API rate limits.
// Fast APIs (direct): every 2h. VPS-dependent: every 4h. Slow/fragile: every 6-8h.

interface PlatformSchedule {
  platform: string
  intervalMs: number
  windows: string[]
}

const FETCH_SCHEDULES: PlatformSchedule[] = [
  // Fast direct APIs — every 2h
  { platform: 'binance_futures', intervalMs: 2 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'binance_spot', intervalMs: 2 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'okx_futures', intervalMs: 2 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'okx_spot', intervalMs: 3 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bybit', intervalMs: 3 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bybit_spot', intervalMs: 3 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bitget_futures', intervalMs: 3 * 3600_000, windows: ['7d', '30d', '90d'] },

  // DEX — every 4h
  { platform: 'hyperliquid', intervalMs: 4 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'gmx', intervalMs: 4 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'gains', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'dydx', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'aevo', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'drift', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'jupiter_perps', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },

  // Medium CEX — every 4-6h
  { platform: 'mexc', intervalMs: 4 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'htx_futures', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bitfinex', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'coinex', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'gateio', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'kucoin', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bitunix', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },

  // Slow / fragile — every 6-8h
  { platform: 'bingx', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'weex', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'woox', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'etoro', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'xt', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'btcc', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'toobit', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'polymarket', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'copin', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  // web3_bot excluded — uses dedicated Web3BotConnector with DeFi Llama/CoinGecko,
  // not SOURCE_TO_CONNECTOR_MAP. Stays on Vercel cron.

  // Web3 wallets
  { platform: 'binance_web3', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'okx_web3', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
]

const SCORE_INTERVALS_MS = 2 * 3600_000 // every 2h

/**
 * Register all repeatable jobs. Idempotent — BullMQ deduplicates by scheduler ID.
 */
export async function registerSchedules(): Promise<void> {
  const queue = getQueue()

  // Per-platform fetch schedules
  for (const sched of FETCH_SCHEDULES) {
    await queue.upsertJobScheduler(
      `fetch:${sched.platform}`,
      { every: sched.intervalMs },
      {
        name: JOB.FETCH_PLATFORM,
        data: { platform: sched.platform, windows: sched.windows } satisfies FetchPlatformData,
      }
    )
  }

  // Score computation — staggered by 5 min per season
  const seasons: Array<{ season: '7D' | '30D' | '90D'; offsetMs: number }> = [
    { season: '7D', offsetMs: 0 },
    { season: '30D', offsetMs: 5 * 60_000 },
    { season: '90D', offsetMs: 10 * 60_000 },
  ]
  for (const { season, offsetMs } of seasons) {
    await queue.upsertJobScheduler(
      `score:${season}`,
      { every: SCORE_INTERVALS_MS, offset: offsetMs },
      {
        name: JOB.COMPUTE_LEADERBOARD,
        data: { season } satisfies ComputeLeaderboardData,
      }
    )
  }

  console.log(
    `[scheduler] Registered ${FETCH_SCHEDULES.length} fetch schedules + ${seasons.length} score schedules`
  )
}
