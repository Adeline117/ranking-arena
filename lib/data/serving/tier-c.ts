/**
 * Tier-C on-demand bridge: Vercel route ↔ region-resident ingest worker
 * (spec §2.4, plan Workstream D).
 *
 * The worker has no inbound reachability, so the cold path is queue +
 * poll: enqueue a BullMQ job with a DETERMINISTIC jobId (cross-lambda
 * single-flight — N viewers of the same trader produce ONE upstream
 * fetch), then poll the Redis result key the worker publishes to
 * (render-before-persist) for up to ~8s. On timeout the route answers
 * 200 {cacheState:'pending'} — this module never throws.
 *
 * Deploy note: requires REDIS_URL (Upstash ioredis URL, same value as
 * worker/.env) in the Vercel environment. Without it every call resolves
 * null and routes degrade to 'pending'.
 *
 * The jobId/result-key builders live in lib/ingest/core/tier-c-keys.ts
 * (zero-dependency), imported by BOTH sides — hand-sync no longer exists.
 */

import type { ConnectionOptions, Queue } from 'bullmq'
import type { Redis } from 'ioredis'
import { logger } from '@/lib/logger'
import { isIngestRegion, type IngestRegion } from '@/lib/ingest/core/regions'
import { tierCQueueName } from '@/lib/ingest/core/tier-c-routing'
import type { RecordKind, ServingCurrency, TraderCoreModules } from './types'
import { intToTf } from './core'

export type TierCSurface = 'profile' | RecordKind

export interface TierCRequest {
  sourceSlug: string
  /** DB-resolved routing authority. Null/unknown requests are never enqueued. */
  fetchRegion: IngestRegion | null
  exchangeTraderId: string
  timeframe: 0 | 7 | 30 | 90
  surface: TierCSurface
}

// Single shared contract — lib/ingest/core/tier-c-keys.ts is zero-dependency
// (no Playwright/pg), safe for the Vercel bundle. Drift class eliminated.
import { tierCJobId, tierCResultKey } from '@/lib/ingest/core/tier-c-keys'
export { tierCJobId, tierCResultKey }

const TIER_C_JOB_NAME = 'tierc:profile' // INGEST_JOB.TIER_C

export interface TierCBridge {
  queue: Pick<Queue, 'add'>
  redis: Pick<Redis, 'get'>
}

export type TierCBridgeProvider = (region: IngestRegion) => Promise<TierCBridge | null>

const bridges = new Map<IngestRegion, { queue: Queue; redis: Redis }>()

async function getBridge(region: IngestRegion): Promise<TierCBridge | null> {
  const existing = bridges.get(region)
  if (existing) return existing
  const url = process.env.REDIS_URL
  if (!url) return null
  try {
    // Dynamic imports: only serving-mode cold paths pay this cost.
    const [{ Queue: BullQueue }, { default: IORedis }] = await Promise.all([
      import('bullmq'),
      import('ioredis'),
    ])
    const redis = new IORedis(url, {
      maxRetriesPerRequest: null, // BullMQ requirement
      enableReadyCheck: false, // Upstash compatibility
      tls: url.startsWith('rediss://') ? {} : undefined,
    })
    redis.on('error', (err) => logger.error('[tier-c] redis error:', err.message))
    // bullmq ships a nested ioredis whose types fork from ours; the runtime
    // client is compatible (same bridge as worker/src/ingest/queues.ts).
    const queue = new BullQueue(tierCQueueName(region), {
      connection: redis as unknown as ConnectionOptions,
    })
    const bridge = { queue, redis }
    bridges.set(region, bridge)
    return bridge
  } catch (err) {
    logger.error('[tier-c] bridge init failed:', err instanceof Error ? err.message : err)
    return null
  }
}

const POLL_INTERVAL_MS = 250
const POLL_TIMEOUT_MS = 8_000

interface RequestTierCOptions {
  /** Fire the job but skip polling (stale-hit background refresh). */
  fireAndForget?: boolean
  timeoutMs?: number
}

/**
 * Enqueue (single-flight) and poll the worker's result key.
 * Resolves the parsed result payload, or null on timeout/any failure.
 */
export async function requestTierC(
  req: TierCRequest,
  opts: RequestTierCOptions = {}
): Promise<Record<string, unknown> | null> {
  return requestTierCWithProvider(req, opts, getBridge)
}

/**
 * Testable core of requestTierC. Keeping the provider explicit proves the
 * resolved DB region selects the queue before any enqueue is attempted.
 */
export async function requestTierCWithProvider(
  req: TierCRequest,
  opts: RequestTierCOptions,
  bridgeProvider: TierCBridgeProvider
): Promise<Record<string, unknown> | null> {
  try {
    if (!isIngestRegion(req.fetchRegion)) {
      logger.error('[tier-c] request rejected: missing or invalid fetch region', {
        sourceSlug: req.sourceSlug,
        fetchRegion: req.fetchRegion,
      })
      return null
    }

    const b = await bridgeProvider(req.fetchRegion)
    if (!b) return null
    const resultKey = tierCResultKey(req)

    // A ≤120s-old result from a previous flight may already be there.
    const existing = await b.redis.get(resultKey)
    if (existing) return JSON.parse(existing) as Record<string, unknown>

    await b.queue.add(TIER_C_JOB_NAME, req, {
      jobId: tierCJobId(req), // deterministic = cross-lambda single-flight
      priority: 1,
      // Completed jobs must clear immediately or the jobId would block
      // re-fetches after the 120s result TTL; failed jobs linger 5 min as
      // a natural backoff against hammering a failing source.
      removeOnComplete: true,
      removeOnFail: { age: 300 },
    })

    if (opts.fireAndForget) return null

    const deadline = Date.now() + (opts.timeoutMs ?? POLL_TIMEOUT_MS)
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
      const raw = await b.redis.get(resultKey)
      if (raw) return JSON.parse(raw) as Record<string, unknown>
    }
    return null
  } catch (err) {
    // NEVER 5xx the user path over the bridge (spec §2.4 degradation).
    logger.error('[tier-c] request failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Result payload mapping — the worker publishes the parsed profile bundle
// (worker/src/ingest/processors/tier-c-profile.ts):
//   { stats: ParsedStats[], series: [{timeframe, metric, points}], currency, asOf }
// ParsedStats keys are camelCase; the serving contract uses the superset
// snake_case keys from lib/constants/metric-registry.ts.
// ---------------------------------------------------------------------------

const STAT_KEY_MAP: Record<string, string> = {
  roi: 'roi',
  pnl: 'pnl',
  sharpe: 'sharpe',
  mdd: 'mdd',
  winRate: 'win_rate',
  winPositions: 'win_positions',
  totalPositions: 'total_positions',
  copierPnl: 'copier_pnl',
  copierCount: 'copier_count',
  aum: 'aum',
  volume: 'volume',
  profitShareRate: 'profit_share_rate',
  holdingDurationAvgHours: 'holding_duration_avg',
}

const CURRENCIES: ReadonlySet<string> = new Set(['USDT', 'USDx', 'USDC', 'USD'])

/** Map a Tier-C profile result into TraderCoreModules (cold-fetched). */
export function coreModulesFromTierC(
  source: string,
  timeframe: 0 | 7 | 30 | 90,
  payload: Record<string, unknown>
): TraderCoreModules | null {
  const statsList = Array.isArray(payload.stats) ? (payload.stats as Record<string, unknown>[]) : []
  const statsRow = statsList.find((s) => Number(s.timeframe) === timeframe) ?? statsList[0]
  if (!statsRow) return null

  const stats: Record<string, number | string | null> = {}
  const extras: Record<string, unknown> = {}
  for (const [from, to] of Object.entries(STAT_KEY_MAP)) {
    const v = statsRow[from]
    if (typeof v === 'number' || typeof v === 'string') stats[to] = v
  }
  if (statsRow.tradingPreferences && typeof statsRow.tradingPreferences === 'object') {
    extras.trading_preferences = statsRow.tradingPreferences
  }
  if (statsRow.extras && typeof statsRow.extras === 'object') {
    Object.assign(extras, statsRow.extras as Record<string, unknown>)
  }

  const series: TraderCoreModules['series'] = {}
  if (Array.isArray(payload.series)) {
    for (const s of payload.series as Array<Record<string, unknown>>) {
      if (Number(s.timeframe) !== timeframe) continue
      if (typeof s.metric === 'string' && Array.isArray(s.points)) {
        series[s.metric] = s.points as Array<{ ts: string; value: number }>
      }
    }
  }

  const asOf =
    typeof payload.asOf === 'string'
      ? payload.asOf
      : typeof statsRow.asOf === 'string'
        ? statsRow.asOf
        : new Date().toISOString()

  return {
    timeframe: intToTf(timeframe),
    stats,
    currency:
      typeof payload.currency === 'string' && CURRENCIES.has(payload.currency)
        ? (payload.currency as ServingCurrency)
        : 'USDT',
    series,
    extras,
    provenance: { source, asOf },
    cacheState: 'cold-fetched',
  }
}
