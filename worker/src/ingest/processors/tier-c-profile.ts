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
import type { IngestRegion } from '@/lib/ingest/core/regions'
import { assertIngestRegion } from '@/lib/ingest/core/tier-c-routing'
import {
  supportsSourceSurface,
  UnsupportedSourceSurfaceError,
  type SurfaceCapability,
} from '@/lib/ingest/core/surface-capabilities'
import { assertPositionSnapshotEvidence } from '@/lib/ingest/core/position-snapshot'
import {
  findIncompleteProfileWindow,
  IncompleteProfileWindowError,
} from '@/lib/ingest/core/profile-coverage'
import type { ProfileQualityReject } from '@/lib/ingest/core/profile-quality'
import type { HistoryKind, ParseCtx, ParsedHistoryRow } from '@/lib/ingest/core/types'
import type { HistoryCompleteness } from '@/lib/data/serving/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { captureHistoryAcquisition } from '@/lib/ingest/history-acquisition'
import {
  writeHistoryRawArtifact,
  writeRawObject,
  type IngestTransactionRunner,
} from '@/lib/ingest/raw'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
import { publishPositions, publishProfile, resolveTraderId } from '@/lib/ingest/serving/publish'
import { getIngestPool } from '@/lib/ingest/db'
import { tierCResultKey, type TierCJobData } from '../queues'
import { runHistoryTransaction } from '../history-transaction'

const RESULT_TTL_SECONDS = 120

type TierCSource = Awaited<ReturnType<typeof getSourceBySlug>>

export async function processTierC(
  job: Job<TierCJobData>,
  expectedRegion: IngestRegion
): Promise<unknown> {
  const { sourceSlug, exchangeTraderId, timeframe, surface } = job.data
  const region = assertIngestRegion(expectedRegion)
  const src = await getSourceBySlug(sourceSlug)
  if (src.fetch_region !== region) {
    throw new Error(
      `[tier-c] source ${sourceSlug} moved from ${region} to ${src.fetch_region} before fetch`
    )
  }
  const adapter = getAdapter(src.adapter_slug)
  const redis = getConnection()
  const resultKey = tierCResultKey(job.data)

  if (surface !== 'profile') {
    return processHeavySurface(job, src)
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

  // The dedicated Tier-C worker runs with concurrency=2. Use two fixed,
  // persistent slots per source so concurrent on-demand jobs cannot share a
  // ProcessSingleton; any future excess concurrency queues for these slots.
  const session = await openSession(src, {
    profileLaneKey: 'tier-c',
    profileSuffix: 'tier-c',
    profileSlotCount: 2,
  })
  try {
    const scrapedAt = new Date().toISOString()
    const bundle = await adapter.getProfile(session, src, exchangeTraderId, timeframe, traderMeta, {
      intent: 'interactive_deferred',
    })

    // Evidence is durable before a parser or quality gate can fail. Reuse this
    // pointer for every outcome; a Tier-C profile fetch writes RAW exactly once.
    const rawObjectId = (
      await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: 'tier_c',
        traderId: existingTraderId,
        timeframe,
        payload: bundle.pages,
      })
    ).id

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

function historyRowsForRender(
  parsed: ParsedHistoryRow[],
  kind: HistoryKind
): Record<string, unknown>[] {
  return parsed.map((row) => {
    if (row.kind !== kind) throw new Error(`[tier-c] history row kind does not match ${kind}`)
    if (row.kind === 'copiers') {
      const { copierLabel: _pii, raw: _raw, ...rest } = row
      return rest
    }
    const { raw: _raw, ...rest } = row
    return rest
  })
}

/**
 * Heavy-tab surfaces (spec §2.4-3): positions / position_history / orders /
 * transfers / copiers — fetched only when the user opens that tab. Same
 * history previews are explicitly partial and live only in the short Redis
 * result. They never enter typed history tables, legacy cursors, or
 * profile_cache. Positions retain their evidence-bound persistence path.
 *
 * Copier PII rule (spec §6): copierLabel never leaves the worker — the
 * Redis preview rows are stripped before publish and this preview-only lane
 * does not write the full row into any typed history table.
 */
async function processHeavySurface(job: Job<TierCJobData>, src: TierCSource): Promise<unknown> {
  const { sourceSlug, exchangeTraderId, timeframe, surface } = job.data
  const adapter = getAdapter(src.adapter_slug)
  const redis = getConnection()
  const resultKey = tierCResultKey(job.data)
  const scrapedAt = new Date().toISOString()
  const capabilityBySurface: Record<Exclude<typeof surface, 'profile'>, SurfaceCapability> = {
    positions: 'positions',
    position_history: 'positionHistory',
    orders: 'orders',
    transfers: 'transfers',
    copiers: 'copiers',
  }
  const capability = capabilityBySurface[surface as Exclude<typeof surface, 'profile'>]
  if (!capability || !supportsSourceSurface(adapter, src, capability)) {
    throw new UnsupportedSourceSurfaceError(sourceSlug, capability ?? 'profile')
  }

  // Profile and heavy-tab jobs share the same bounded Tier-C slot pool.
  const session = await openSession(src, {
    profileLaneKey: 'tier-c',
    profileSuffix: 'tier-c',
    profileSlotCount: 2,
  })
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
      const bundle = await adapter.getPositions(session, src, exchangeTraderId, traderMeta)
      rawPayload = bundle.pages
      await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: 'tier_c',
        traderId,
        timeframe,
        payload: rawPayload,
        meta: { surface },
      })
      rawPersisted = true
      const positionEvidence = assertPositionSnapshotEvidence(
        bundle,
        `${src.slug}/${exchangeTraderId}`
      )
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
      await publishPositions(src, traderId, positions, asOf, positionEvidence)
    } else {
      const kind = surface as HistoryKind
      const acquisition = await captureHistoryAcquisition({
        source: src,
        traderId,
        exchangeTraderId,
        kind,
        cursor: null,
        attemptStartedAt: scrapedAt,
        callerPageCap: 2,
        stream: adapter.getHistory(session, src, exchangeTraderId, kind, null, traderMeta),
        terminalVerifier: adapter.historyTerminalVerifier?.(src, kind) ?? undefined,
      })
      rawPayload = acquisition.pages
      const rawInput = { artifact: acquisition.artifact, sourceRunId: acquisition.sourceRunId }

      if (acquisition.error !== null) {
        await writeHistoryRawArtifact(rawInput, runHistoryTransaction)
        throw acquisition.error
      }

      const termination = acquisition.artifact.termination
      const observedAt = acquisition.artifact.pages.at(-1)?.fetched_at ?? null
      const historyCompleteness: HistoryCompleteness = {
        state: 'partial',
        reason: 'interactive_preview',
        evidenceState: termination.evidence_state,
        scanTerminalState: termination.scan_terminal_state,
        blockerReasons: [...termination.blocker_reasons],
      }
      const renderPayload = () => ({
        rows,
        nextCursor: null,
        asOf: observedAt ?? scrapedAt,
        sourceAsOf: null,
        observedAt,
        publishedAt: null,
        completeness: historyCompleteness,
      })

      let storageDurable = false
      let rawPointerDurable = false
      const renderPreviewWithRaw: IngestTransactionRunner = async (persistRawPointer) => {
        // The immutable audit pointer commits before any untrusted parser or
        // Redis work. This lane is preview-only and cannot mutate typed facts,
        // evidence cursors, or the warm profile cache.
        storageDurable = true
        const receipt = await runHistoryTransaction(persistRawPointer)
        rawPointerDurable = true
        const parsed = acquisition.pages.flatMap((page) =>
          adapter.parseHistory(page.payload, kind, ctx)
        )
        rows = historyRowsForRender(parsed, kind)
        await redis.set(resultKey, JSON.stringify(renderPayload()), 'EX', 120)
        return receipt
      }

      try {
        await writeHistoryRawArtifact(rawInput, renderPreviewWithRaw)
      } catch (cause) {
        if (storageDurable && !rawPointerDurable) {
          try {
            await writeHistoryRawArtifact(rawInput, runHistoryTransaction)
          } catch (rawCause) {
            throw new AggregateError(
              [
                cause instanceof Error ? cause : new Error(String(cause)),
                rawCause instanceof Error ? rawCause : new Error(String(rawCause)),
              ],
              '[tier-c] history preview failure and RAW audit persistence both failed'
            )
          }
        }
        throw cause
      }

      return {
        traderId,
        surface,
        rows: rows.length,
        completeness: historyCompleteness,
      }
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
