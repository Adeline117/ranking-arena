/**
 * arena-ingest queue — separate from the legacy arena-pipeline queue so a
 * crash loop in new ingestion code can never stall the live pipeline
 * (parallel-build requirement). Shares the Redis connection module.
 */

import { Queue, type ConnectionOptions } from 'bullmq'
import { getConnection } from '../connection'

/** bullmq ships a nested ioredis copy whose types fork from ours — the
 *  runtime client is compatible, so bridge the nominal mismatch once. */
export function ingestConnection(): ConnectionOptions {
  return getConnection() as unknown as ConnectionOptions
}

export const INGEST_QUEUE_NAME = 'arena-ingest'

/**
 * Tier-C runs on its OWN queue + worker slots: bulk Tier-A/B crawls hold
 * the main queue's 3 slots for up to ~hours, and a user-facing on-demand
 * fetch must never wait behind them (the route's polling window is 8s).
 */
export const TIERC_QUEUE_NAME = 'arena-ingest-tierc'

let tiercQueue: Queue | null = null

export function getTierCQueue(): Queue {
  if (tiercQueue) return tiercQueue
  tiercQueue = new Queue(TIERC_QUEUE_NAME, {
    connection: ingestConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 24 * 3600, count: 500 },
    },
  })
  return tiercQueue
}

let queue: Queue | null = null

export function getIngestQueue(): Queue {
  if (queue) return queue
  queue = new Queue(INGEST_QUEUE_NAME, {
    connection: ingestConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
    },
  })
  return queue
}

export const INGEST_JOB = {
  /** Tier A: full leaderboard crawl, all native TFs for one source. */
  TIER_A: 'tiera:leaderboard',
  /** Tier B: deep-profile crawl of topN for one source. */
  TIER_B: 'tierb:profiles',
  /** Tier C: on-demand single profile surface (priority 1, from Vercel). */
  TIER_C: 'tierc:profile',
  /** Tier D: open positions for top-100 of one source. */
  TIER_D: 'tierd:positions',
  /** Derived boards synthesis (MEXC/BTCC, spec §1.1-C). */
  DERIVE_BOARDS: 'derive:boards',
  /** Avatar mirroring (first-sight + weekly refresh). */
  AVATAR_MIRROR: 'maint:avatar-mirror',
  /** Partitions + RAW cleanup + downsample + retention. */
  MAINTENANCE: 'maint:housekeeping',
  /** Freshness SLA sentinel (spec §5.4). */
  FRESHNESS: 'maint:freshness',
  /** Daily digest of non-paging alerts (spec §15). */
  DAILY_DIGEST: 'maint:daily-digest',
} as const

export interface TierJobData {
  sourceSlug: string
}

export interface TierCJobData {
  sourceSlug: string
  exchangeTraderId: string
  timeframe: 0 | 7 | 30 | 90
  surface: 'profile' | 'positions' | 'position_history' | 'orders' | 'transfers' | 'copiers'
}

/** Deterministic jobId = coalescing key (single-flight, spec §2.4).
 *  BullMQ rejects custom ids containing ':' — '--' is the separator.
 *  Must stay in sync with lib/data/serving/tier-c.ts (Vercel-side copy). */
export function tierCJobId(d: TierCJobData): string {
  return ['tierc', d.sourceSlug, d.exchangeTraderId, d.timeframe, d.surface].join('--')
}

/** Redis key the worker publishes Tier-C results to (render-before-persist). */
export function tierCResultKey(d: TierCJobData): string {
  return `arena:live:${d.sourceSlug}:${d.exchangeTraderId}:${d.timeframe}:${d.surface}`
}
