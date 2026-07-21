/**
 * arena-ingest queue — separate from the legacy arena-pipeline queue so a
 * crash loop in new ingestion code can never stall the live pipeline
 * (parallel-build requirement). Shares the Redis connection module.
 */

import { Queue, type ConnectionOptions } from 'bullmq'
import { getConnection } from '../connection'
import { INGEST_REGIONS, parseIngestRegionsEnv, type IngestRegion } from '@/lib/ingest/core/regions'
import { LEGACY_TIER_C_QUEUE_NAME, tierCQueueName } from '@/lib/ingest/core/tier-c-routing'

export { INGEST_REGIONS, type IngestRegion, tierCQueueName }

/** bullmq ships a nested ioredis copy whose types fork from ours — the
 *  runtime client is compatible, so bridge the nominal mismatch once. */
export function ingestConnection(): ConnectionOptions {
  return getConnection() as unknown as ConnectionOptions
}

export const INGEST_QUEUE_NAME = 'arena-ingest'

/**
 * Region-affine queues (architecture: kill the remote-browser failure
 * chain instead of self-healing it). Bulk tier jobs for a source are
 * enqueued onto its fetch_region's queue:
 *   local   → arena-ingest          (Mac Mini)
 *   vps_sg  → arena-ingest-vps_sg   (consumed by Mac Mini via remote WS
 *             today; by a worker ON the VPS — where the source becomes
 *             effectively local — once deployed there)
 * A worker consumes the queues listed in INGEST_REGIONS (default: all,
 * preserving single-node behavior). Tier-C has a dedicated queue for each
 * region (user-facing latency path).
 */
export function regionQueueName(region: string): string {
  return region === 'local' ? INGEST_QUEUE_NAME : `${INGEST_QUEUE_NAME}-${region}`
}

/**
 * Fast-lane queue (2026-06-13 slot-starvation root fix). Light Tier-A
 * leaderboard crawls (small boards, seconds-to-minutes) run on a SEPARATE
 * worker pool from the bulk queue so a giant multi-hour crawl (bybit_mt5 ≈
 * 29k traders / 2-3h, hyperliquid 10k, binance 9.6k) can NEVER monopolize
 * every slot and starve the 26 small user-facing leaderboards (bitget_spot's
 * neighbours htx/bitfinex/okx sat 14-24h stale behind bybit_mt5). Only
 * Tier-A of small sources is siphoned here; heavy Tier-A + ALL Tier-B/D/
 * series/derive stay on the bulk queue unchanged.
 */
export function regionFastQueueName(region: string): string {
  return region === 'local' ? `${INGEST_QUEUE_NAME}-fast` : `${INGEST_QUEUE_NAME}-fast-${region}`
}

/**
 * Tier-A sources with expected_count at/below this go to the fast lane.
 * Above it (or NULL = unknown size, treat as heavy) stay on bulk. Tuned to
 * the 2026-06-13 board sizes: splits ~26 light vs ~9 heavy (bybit_mt5 29k …
 * bitunix 4k heavy; gate_cfd 2.7k and below light).
 */
export const FAST_TIER_A_MAX_COUNT = 3000

/** A source's Tier-A is fast-lane eligible iff its board is known-small. */
export function isFastTierA(expectedCount: number | null | undefined): boolean {
  return (
    typeof expectedCount === 'number' && expectedCount > 0 && expectedCount <= FAST_TIER_A_MAX_COUNT
  )
}

/**
 * Fast lane is OFF by default. The routing change is GLOBAL (both the Mac and
 * the SG-VPS node run reconcileSchedulers over every source), so enabling it on
 * one node while the other runs old code would make them fight over the same
 * tiera:<slug> scheduler (one moves it to fast, the other re-adds it to bulk →
 * double crawls + thrash). Gating on an env flag lets the code land inert, then
 * be switched on BOTH nodes' .env together (INGEST_FAST_LANE=1) + restarted.
 * Flipping it back off cleanly returns every Tier-A to the bulk queue (the
 * reconcile cleanup removes the now-unwanted fast-lane schedulers).
 *
 * MUST be a function, NOT a module-level const: ingest-worker.ts calls dotenv
 * `config()` as a STATEMENT, but ESM hoists every `import` (including this
 * module) above it — a const would read process.env before .env is loaded and
 * latch `false` forever (observed: ready log showed fast-lane=off despite
 * INGEST_FAST_LANE=1). Read lazily so callers inside main()/reconcile — which
 * run after config() — see the real value.
 */
export function fastLaneEnabled(): boolean {
  return process.env.INGEST_FAST_LANE === '1'
}

const regionQueues = new Map<string, Queue>()

function buildQueue(name: string): Queue {
  return new Queue(name, {
    connection: ingestConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: { age: 24 * 3600, count: 500 },
      removeOnFail: { age: 7 * 24 * 3600, count: 2000 },
    },
  })
}

export function getRegionQueue(region: string): Queue {
  const name = regionQueueName(region)
  let q = regionQueues.get(name)
  if (!q) {
    q = buildQueue(name)
    regionQueues.set(name, q)
  }
  return q
}

export function getFastQueue(region: string): Queue {
  const name = regionFastQueueName(region)
  let q = regionQueues.get(name)
  if (!q) {
    q = buildQueue(name)
    regionQueues.set(name, q)
  }
  return q
}

/** Regions THIS worker process consumes (env INGEST_REGIONS=vps_sg on a VPS node). */
export function consumedRegions(): IngestRegion[] {
  const requireExplicit =
    process.env.NODE_ENV === 'production' ||
    process.env.pm_id !== undefined ||
    process.env.NODE_APP_INSTANCE !== undefined
  return parseIngestRegionsEnv(process.env.INGEST_REGIONS, { requireExplicit })
}

/**
 * Tier-C runs on its OWN queue + worker slots: bulk Tier-A/B crawls hold
 * the main queue's 3 slots for up to ~hours, and a user-facing on-demand
 * fetch must never wait behind them (the route's polling window is 8s).
 */
/** @deprecated Use tierCQueueName(region). Kept for old producers/observers. */
export const TIERC_QUEUE_NAME = LEGACY_TIER_C_QUEUE_NAME

const tiercQueues = new Map<string, Queue>()

export function getTierCQueue(region: IngestRegion = 'local'): Queue {
  const name = tierCQueueName(region)
  const existing = tiercQueues.get(name)
  if (existing) return existing
  const queue = new Queue(name, {
    connection: ingestConnection(),
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5_000 },
      removeOnComplete: { age: 3600, count: 200 },
      removeOnFail: { age: 24 * 3600, count: 500 },
    },
  })
  tiercQueues.set(name, queue)
  return queue
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
  /** Tier B-S: slow series backfill for ranked traders beyond topN (spec §13.1). */
  TIER_B_SERIES: 'tierb:series',
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
  /** On-chain recompute of top-N web3 wallet profile detail (Phase A). */
  ONCHAIN_ENRICH: 'maint:onchain-enrich',
  /** First-party sync of a claimed trader's own account (认领 P1). */
  FIRST_PARTY: 'firstparty:sync',
} as const

export interface TierJobData {
  sourceSlug: string
  /**
   * Tier-A only: native windows whose entire publication pipeline completed
   * during this BullMQ job. Persisted with Job.updateData after RAW, snapshot,
   * board-series and bot publication all succeed so a retry/stall recovery can
   * resume at the first unfinished window instead of crawling from page 1.
   * Repeat-scheduler templates omit it, so every new observation starts clean.
   */
  completedTimeframes?: Array<7 | 30 | 90>
  /**
   * Tier-B deadline continuations only: how many continuation hops this
   * chain has taken. Scheduler-fired iterations omit it (chain restarts at
   * 0); processTierB stops re-enqueuing past a bound so a slow-failing
   * source can't self-requeue forever.
   */
  contDepth?: number
}

export interface TierCJobData {
  sourceSlug: string
  exchangeTraderId: string
  timeframe: 0 | 7 | 30 | 90
  surface: 'profile' | 'positions' | 'position_history' | 'orders' | 'transfers' | 'copiers'
  /** Producer routing hint. Optional so pre-regionalization jobs stay valid. */
  fetchRegion?: IngestRegion
  /** Stable ID of the original legacy flight; present only after a reroute. */
  tierCRouteToken?: string
  /** Bounded legacy handoff count. Current contract permits exactly one hop. */
  tierCRouteHop?: number
}

// Single shared contract — see lib/ingest/core/tier-c-keys.ts (drift-proof).
export { tierCJobId, tierCResultKey } from '@/lib/ingest/core/tier-c-keys'
