/**
 * Tier C on-demand profile fetch (spec §2.3-C, §2.4).
 *
 * Triggered by a profile page-view on a cold-cache long-tail trader.
 * Single-flight comes from the deterministic BullMQ jobId; priority 1 puts
 * these ahead of bulk Tier-B work.
 *
 * RENDER-BEFORE-PERSIST: the parsed payload is written to a short-lived
 * Redis result key FIRST (the Vercel route is polling it) and only then
 * persisted to profile_cache / trader_stats / trader_series — DB write
 * latency never sits in the user's critical path.
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getAdapter } from '@/lib/ingest/core/adapter'
import type { ParseCtx } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { publishProfile, resolveTraderId } from '@/lib/ingest/serving/publish'
import { getIngestPool } from '@/lib/ingest/db'
import { tierCResultKey, type TierCJobData } from '../queues'

const RESULT_TTL_SECONDS = 120

export async function processTierC(job: Job<TierCJobData>): Promise<unknown> {
  const { sourceSlug, exchangeTraderId, timeframe, surface } = job.data
  const src = await getSourceBySlug(sourceSlug)
  const adapter = getAdapter(src.adapter_slug)
  const redis = getConnection()
  const resultKey = tierCResultKey(job.data)

  if (surface !== 'profile') {
    // Heavy-tab surfaces (positions/histories/copiers) plug in here as the
    // adapter implements them; until then fail fast so the route's polling
    // window expires into its graceful 'pending' state.
    throw new Error(`[tier-c] surface ${surface} not implemented for ${sourceSlug}`)
  }

  const session = await openSession(src)
  try {
    const scrapedAt = new Date().toISOString()
    const bundle = await adapter.getProfile(session, src, exchangeTraderId, timeframe)

    const ctx: ParseCtx = {
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt,
      meta: src.meta,
    }
    const profile = adapter.parseProfile(bundle.pages[0]?.payload, ctx)

    // 1. Render path: publish to Redis FIRST — waiters resolve immediately.
    const payload = {
      stats: profile.stats,
      series: profile.series,
      currency: src.currency,
      asOf: scrapedAt,
    }
    await redis.set(resultKey, JSON.stringify(payload), 'EX', RESULT_TTL_SECONDS)

    // 2. Persist path (async from the user's perspective — they already
    //    have the payload): RAW + identity + stats/series + profile_cache.
    const traderId = await resolveTraderId(src, exchangeTraderId)
    await writeRawObject({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: 'tier_c',
      traderId,
      timeframe,
      payload: bundle.pages,
    })
    await publishProfile(src, traderId, profile, { fullSeries: false }) // long tail (spec §13.1)
    await getIngestPool().query(
      `INSERT INTO arena.profile_cache
         (trader_id, timeframe, surface, fetched_at, expires_at, is_refreshing, payload)
       VALUES ($1, $2, $3, now(), now() + ($4 || ' seconds')::interval, false, $5)
       ON CONFLICT (trader_id, timeframe, surface) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at,
         is_refreshing = false,
         payload = EXCLUDED.payload`,
      [traderId, timeframe, surface, src.profile_cache_ttl_seconds, JSON.stringify(payload)]
    )

    return { traderId, stats: profile.stats.length, series: profile.series.length }
  } finally {
    await session.close()
  }
}
