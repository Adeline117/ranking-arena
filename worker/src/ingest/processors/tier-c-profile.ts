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
import {
  getHistoryCursor,
  publishHistoryRows,
  publishPositions,
  publishProfile,
  resolveTraderId,
} from '@/lib/ingest/serving/publish'
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
    return processHeavySurface(job)
  }

  // UTA portfolio traders route profile calls by traders.meta (portfolio_id)
  // — load it so long-tail UTA profiles fetch correctly instead of empty.
  const { rows: metaRows } = await getIngestPool().query<{
    meta: Record<string, unknown>
  }>(
    `SELECT t.meta FROM arena.traders t
      WHERE t.source_id = $1 AND t.exchange_trader_id = $2`,
    [src.id, exchangeTraderId]
  )
  const traderMeta = metaRows[0]?.meta ?? null

  const session = await openSession(src)
  try {
    const scrapedAt = new Date().toISOString()
    const bundle = await adapter.getProfile(session, src, exchangeTraderId, timeframe, traderMeta)

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

/**
 * Heavy-tab surfaces (spec §2.4-3): positions / position_history / orders /
 * transfers / copiers — fetched only when the user opens that tab. Same
 * render-before-persist contract: Redis result key {rows, nextCursor, asOf}
 * first, then arena.* persistence + profile_cache.
 *
 * Copier PII rule (spec §6): copierLabel never leaves the worker — the
 * Redis rows are stripped before publish; full rows (with label, for
 * dedupe) only reach arena.copier_records which has no public access.
 */
async function processHeavySurface(job: Job<TierCJobData>): Promise<unknown> {
  const { sourceSlug, exchangeTraderId, timeframe, surface } = job.data
  const src = await getSourceBySlug(sourceSlug)
  const adapter = getAdapter(src.adapter_slug)
  const redis = getConnection()
  const resultKey = tierCResultKey(job.data)
  const scrapedAt = new Date().toISOString()

  const session = await openSession(src)
  try {
    const ctx: ParseCtx = {
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt,
      meta: src.meta,
    }
    const traderId = await resolveTraderId(src, exchangeTraderId)

    let rows: Record<string, unknown>[] = []
    let rawPayload: unknown = null

    if (surface === 'positions') {
      if (!adapter.capabilities.positions) {
        throw new Error(`[tier-c] ${sourceSlug} does not expose positions`)
      }
      const bundle = await adapter.getPositions(session, src, exchangeTraderId)
      rawPayload = bundle.pages
      const positions = bundle.pages.flatMap((p) => adapter.parsePositions(p.payload, ctx))
      rows = positions.map((p) => ({ ...p, currency: src.currency }))

      await redis.set(
        resultKey,
        JSON.stringify({ rows, nextCursor: null, asOf: scrapedAt }),
        'EX',
        120
      )
      const delayHours = Number(src.meta.positions_delay_hours ?? 0)
      const asOf = new Date(Date.parse(scrapedAt) - delayHours * 3600_000).toISOString()
      await publishPositions(src, traderId, positions, asOf)
    } else {
      const kind = surface as import('@/lib/ingest/core/types').HistoryKind
      const capabilityByKind: Record<string, boolean> = {
        position_history: adapter.capabilities.positionHistory,
        orders: adapter.capabilities.orders,
        transfers: adapter.capabilities.transfers,
        copiers: adapter.capabilities.copiers,
      }
      if (!capabilityByKind[kind]) {
        throw new Error(`[tier-c] ${sourceSlug} does not expose ${kind}`)
      }

      const cursor = await getHistoryCursor(traderId, kind)
      const pages: import('@/lib/ingest/core/types').RawPage[] = []
      // On-demand view needs the freshest page or two; deeper pagination is
      // served from arena.* by the records route, not by re-fetching.
      for await (const page of adapter.getHistory(session, src, exchangeTraderId, kind, cursor)) {
        pages.push(page)
        if (pages.length >= 2) break
      }
      rawPayload = pages
      const parsed = pages.flatMap((p) => adapter.parseHistory(p.payload, kind, ctx))

      // PII strip for the render path (spec §6) — aggregates only for copiers.
      rows =
        kind === 'copiers'
          ? parsed.map((r) => {
              const {
                copierLabel: _pii,
                raw: _raw,
                ...rest
              } = r as Record<string, unknown> & {
                copierLabel?: unknown
                raw?: unknown
              }
              return rest
            })
          : parsed.map((r) => {
              const { raw: _raw, ...rest } = r as Record<string, unknown> & { raw?: unknown }
              return rest
            })

      await redis.set(
        resultKey,
        JSON.stringify({ rows, nextCursor: null, asOf: scrapedAt }),
        'EX',
        120
      )

      const newCursor = parsed.length > 0 ? scrapedAt : null
      await publishHistoryRows(src, traderId, kind, parsed, newCursor)
    }

    // Persist path (after render): RAW + profile_cache for warm re-reads.
    await writeRawObject({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: 'tier_c',
      traderId,
      timeframe,
      payload: rawPayload,
      meta: { surface },
    })
    await getIngestPool().query(
      `INSERT INTO arena.profile_cache
         (trader_id, timeframe, surface, fetched_at, expires_at, is_refreshing, payload)
       VALUES ($1, $2, $3, now(), now() + ($4 || ' seconds')::interval, false, $5)
       ON CONFLICT (trader_id, timeframe, surface) DO UPDATE SET
         fetched_at = EXCLUDED.fetched_at,
         expires_at = EXCLUDED.expires_at,
         is_refreshing = false,
         payload = EXCLUDED.payload`,
      [
        traderId,
        timeframe,
        surface,
        src.profile_cache_ttl_seconds,
        JSON.stringify({ rows, nextCursor: null, asOf: scrapedAt }),
      ]
    )

    return { traderId, surface, rows: rows.length }
  } finally {
    await session.close()
  }
}
