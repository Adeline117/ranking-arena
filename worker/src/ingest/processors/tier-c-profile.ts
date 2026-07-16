/**
 * Tier C on-demand profile fetch (spec §2.3-C, §2.4).
 *
 * Triggered by a profile page-view on a cold-cache long-tail trader.
 * Single-flight comes from the deterministic BullMQ jobId; priority 1 puts
 * these ahead of bulk Tier-B work.
 *
 * RAW-BEFORE-RENDER: immutable evidence is persisted before parsing or any
 * source-specific quality gate. Proven payloads are then written to the
 * short-lived Redis result key before serving persistence. Quality rejects
 * write a terminal, non-renderable Redis marker so pollers stop promptly, but
 * never enter profile_cache / trader_stats / trader_series.
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getAdapter } from '@/lib/ingest/core/adapter'
import { nextHistoryCursor } from '@/lib/ingest/core/history-cursor'
import {
  findIncompleteProfileWindow,
  IncompleteProfileWindowError,
} from '@/lib/ingest/core/profile-coverage'
import type { ProfileQualityReject } from '@/lib/ingest/core/profile-quality'
import type { ParseCtx } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
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
  const { rows: traderRows } = await getIngestPool().query<{
    id: number
    meta: Record<string, unknown> | null
  }>(
    `SELECT t.id, t.meta FROM arena.traders t
      WHERE t.source_id = $1 AND t.exchange_trader_id = $2`,
    [src.id, exchangeTraderId]
  )
  const existingTraderId = traderRows[0]?.id ?? null
  const traderMeta = traderRows[0]?.meta ?? null

  // 认领交易员停抓(P3-P2): 第一方 sync 才是权威数据源;按需抓取直接跳过
  // (/trader/ 页对 claimed 已重定向到 /u/,这里几乎不会被触发,兜底而已)。
  if (traderMeta && (traderMeta as { claimed?: unknown }).claimed === true) {
    console.warn(`[tier-c] skip claimed trader ${src.slug}/${exchangeTraderId}`)
    return { surfacesFetched: 0, skipped: 'claimed' }
  }

  const session = await openSession(src)
  try {
    const scrapedAt = new Date().toISOString()
    const bundle = await adapter.getProfile(session, src, exchangeTraderId, timeframe, traderMeta, {
      intent: 'interactive_deferred',
    })

    // Evidence is durable before a parser or quality gate can fail. Reuse this
    // pointer for every outcome; a Tier-C profile fetch writes RAW exactly once.
    const rawObjectId = await writeRawObject({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: 'tier_c',
      traderId: existingTraderId,
      timeframe,
      payload: bundle.pages,
    })

    const ctx: ParseCtx = {
      sourceSlug: src.slug,
      currency: src.currency,
      tfLabelMap: src.tf_label_map,
      scrapedAt,
      meta: src.meta,
    }
    const firstPage = bundle.pages[0]
    const qualityRejects: ProfileQualityReject[] = []
    const profile = firstPage ? adapter.parseProfile(firstPage.payload, ctx) : null

    if (profile && adapter.validateProfile) {
      qualityRejects.push(...adapter.validateProfile(profile, ctx, timeframe, firstPage.payload))
    } else if (!firstPage) {
      // An empty bundle must never look like a successful profile fetch simply
      // because there was nothing to parse or validate.
      qualityRejects.push({
        reason: 'profile_payload_missing',
        payload: {
          source_slug: src.slug,
          exchange_trader_id: exchangeTraderId,
          requested_timeframe: timeframe,
          scraped_at: scrapedAt,
          page_count: 0,
        },
      })
    }

    if (qualityRejects.length > 0) {
      // The audit is part of the terminal contract: if it fails, fail the job
      // and leave no Redis marker that could hide the missing evidence trail.
      await recordStagingRejects(src.id, rawObjectId, qualityRejects)
      const terminalPayload = {
        completed: true,
        qualityRejected: true,
        reason: qualityRejects[0].reason,
        timeframe,
        asOf: scrapedAt,
      }
      await redis.set(resultKey, JSON.stringify(terminalPayload), 'EX', RESULT_TTL_SECONDS)
      return {
        traderId: existingTraderId,
        qualityRejected: true,
        reason: qualityRejects[0].reason,
        rejects: qualityRejects.length,
      }
    }

    // `profile === null` implies an empty bundle, which is always rejected
    // above. Keep the invariant explicit for type narrowing and future edits.
    if (!profile) throw new Error('[tier-c] profile payload missing after quality gate')
    const incomplete = findIncompleteProfileWindow(profile)

    if (incomplete) {
      const traderId = await resolveTraderId(src, exchangeTraderId)
      await publishProfile(src, traderId, profile, { fullSeries: false })
      throw new IncompleteProfileWindowError(incomplete.timeframe, incomplete.reason)
    }

    // 1. Render path: publish to Redis FIRST — waiters resolve immediately.
    const targetTimeframe = timeframe === 0 ? 90 : timeframe
    const profileAsOf =
      profile.stats.find((stat) => stat.timeframe === targetTimeframe)?.asOf ?? scrapedAt
    const payload = {
      stats: profile.stats,
      series: profile.series,
      currency: src.currency,
      asOf: profileAsOf,
    }
    await redis.set(resultKey, JSON.stringify(payload), 'EX', RESULT_TTL_SECONDS)

    // 2. Persist path (async from the user's perspective — they already
    //    have the payload): identity + stats/series + profile_cache. RAW was
    //    written before parsing and is deliberately not duplicated here.
    const traderId = await resolveTraderId(src, exchangeTraderId)
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

    // Some adapters route record fetches by traders.meta (e.g. bingx detail SPA
    // needs bingx_api_identity to build the signed detail URL) — load it so the
    // harvest can navigate; omitting it degrades to an empty surface.
    const { rows: metaRows } = await getIngestPool().query<{
      meta: Record<string, unknown>
    }>(`SELECT t.meta FROM arena.traders t WHERE t.source_id = $1 AND t.exchange_trader_id = $2`, [
      src.id,
      exchangeTraderId,
    ])
    const traderMeta = metaRows[0]?.meta ?? null

    let rows: Record<string, unknown>[] = []
    let rawPayload: unknown = null
    let rawPersisted = false

    if (surface === 'positions') {
      if (!adapter.capabilities.positions) {
        throw new Error(`[tier-c] ${sourceSlug} does not expose positions`)
      }
      const bundle = await adapter.getPositions(session, src, exchangeTraderId, traderMeta)
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
      let fetchError: unknown = null
      let callerLimited = false
      // On-demand view needs the freshest page or two; deeper pagination is
      // served from arena.* by the records route, not by re-fetching.
      try {
        for await (const page of adapter.getHistory(
          session,
          src,
          exchangeTraderId,
          kind,
          cursor,
          traderMeta
        )) {
          pages.push(page)
          if (pages.length >= 2) {
            callerLimited = true
            break
          }
        }
      } catch (error) {
        fetchError = error
      }
      rawPayload = pages

      // Evidence first: parser/publication failures must leave a replayable
      // account of every source page received before the checkpoint stayed put.
      await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: 'tier_c',
        traderId,
        timeframe,
        payload: rawPayload,
        meta: {
          surface,
          caller_limited: callerLimited,
          fetch_failed: fetchError !== null,
        },
      })
      rawPersisted = true
      if (fetchError !== null) throw fetchError

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

      await publishHistoryRows(
        src,
        traderId,
        kind,
        parsed,
        callerLimited ? null : nextHistoryCursor(parsed, cursor)
      )
    }

    // Persist path (after render): RAW + profile_cache for warm re-reads.
    if (!rawPersisted) {
      await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: 'tier_c',
        traderId,
        timeframe,
        payload: rawPayload,
        meta: { surface },
      })
    }
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
