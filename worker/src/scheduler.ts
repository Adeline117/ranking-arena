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
  // RETIRED → arena-ingest-worker (ARENA_DATA_SPEC rebuild): bybit (→
  // bybit_copytrade), bitget_futures, hyperliquid, mexc are fetched by the
  // new unified pipeline. Re-adding them here would double-fetch.
  // Wave 2 retired: htx_futures, coinex, gateio, kucoin, bingx, xt.
  // Fast direct APIs — every 2h
  { platform: 'binance_futures', intervalMs: 2 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'binance_spot', intervalMs: 2 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'okx_futures', intervalMs: 2 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'okx_spot', intervalMs: 3 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bybit_spot', intervalMs: 3 * 3600_000, windows: ['7d', '30d', '90d'] },

  // DEX — every 4h
  { platform: 'gmx', intervalMs: 4 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'gains', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'dydx', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'aevo', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'drift', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'jupiter_perps', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },

  // Medium CEX — every 4-6h
  { platform: 'bitfinex', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'bitunix', intervalMs: 6 * 3600_000, windows: ['7d', '30d', '90d'] },

  // Slow / fragile — every 6-8h
  { platform: 'weex', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'woox', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
  { platform: 'etoro', intervalMs: 8 * 3600_000, windows: ['7d', '30d', '90d'] },
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

  // Enrichment — fallback schedule (event-driven also triggers after fetch)
  const ENRICH_INTERVAL_MS = 4 * 3600_000 // every 4h fallback
  for (const period of ['7D', '30D', '90D']) {
    for (const tier of ['fast', 'slow']) {
      await queue.upsertJobScheduler(
        `enrich:${period}:${tier}`,
        { every: ENRICH_INTERVAL_MS },
        {
          name: JOB.ENRICH_PLATFORM,
          data: { period, tier, limit: 200 },
        }
      )
    }
  }

  // Meilisearch sync — fallback schedule (event-driven also triggers after score)
  await queue.upsertJobScheduler(
    'meilisearch-sync',
    { every: 2 * 3600_000 }, // every 2h fallback
    { name: JOB.SYNC_MEILISEARCH, data: {} }
  )

  const enrichSchedules = 6 // 3 periods × 2 tiers
  console.log(
    `[scheduler] Registered ${FETCH_SCHEDULES.length} fetch + ${seasons.length} score + ${enrichSchedules} enrich + 1 meilisearch schedules`
  )
}
