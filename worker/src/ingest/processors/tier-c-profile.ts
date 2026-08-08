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
import type {
  Currency,
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedPosition,
} from '@/lib/ingest/core/types'
import type { HistoryCompleteness } from '@/lib/data/serving/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { captureHistoryAcquisition } from '@/lib/ingest/history-acquisition'
import {
  writeHistoryRawArtifact,
  writeRawObject,
  type IngestTransactionRunner,
} from '@/lib/ingest/raw'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
import { publishPositions, publishProfile } from '@/lib/ingest/serving/publish'
import { getIngestPool } from '@/lib/ingest/db'
import { tierCResultKey, type TierCJobData } from '../queues'
import { runHistoryTransaction } from '../history-transaction'
import { publishCapturedVerifiedCopierSnapshot } from '../verified-copier-snapshot-publisher'

const RESULT_TTL_SECONDS = 120
const COPIER_READY_CONTRACT = 'arena.tier-c.copier-ready@1'

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
  if (src.status !== 'active' || src.serving_mode !== 'serving') {
    throw new Error(
      `[tier-c] source ${sourceSlug} is not active serving ` +
        `(status=${src.status}, serving_mode=${src.serving_mode})`
    )
  }

  const { rows: traderRows } = await getIngestPool().query<{
    id: number
    meta: Record<string, unknown> | null
  }>(
    `SELECT t.id, t.meta FROM arena.traders t
      WHERE t.source_id = $1 AND t.exchange_trader_id = $2
      LIMIT 1`,
    [src.id, exchangeTraderId]
  )
  const trader = traderRows[0]
  if (!trader) {
    throw new Error(`[tier-c] trader is not an existing serving subject: ${sourceSlug}`)
  }
  const traderId = trader.id
  const traderMeta = trader.meta ?? null

  // First-party sync is authoritative for claimed traders. This guard applies
  // to every surface, including forged or stale queue jobs that bypass routes.
  if (traderMeta && (traderMeta as { claimed?: unknown }).claimed === true) {
    console.warn(`[tier-c] skip claimed trader ${src.slug}/${exchangeTraderId}`)
    return { surfacesFetched: 0, skipped: 'claimed' }
  }

  if (surface !== 'profile') {
    return processHeavySurface(job, src, traderId, traderMeta)
  }

  const adapter = getAdapter(src.adapter_slug)
  const redis = getConnection()
  const resultKey = tierCResultKey(job.data)

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
        traderId,
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
        traderId,
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
    //    have the payload): stats/series + profile_cache for the pre-authorized
    //    existing trader. RAW was written before parsing and is not duplicated.
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

function positionRowsForRender(
  parsed: ParsedPosition[],
  currency: Currency
): Record<string, unknown>[] {
  return parsed.map((row) => ({
    symbol: row.symbol,
    side: row.side,
    leverage: row.leverage,
    size: row.size,
    entry_price: row.entryPrice,
    mark_price: row.markPrice,
    unrealized_pnl: row.unrealizedPnl,
    currency,
  }))
}

function historyRowsForRender(
  parsed: ParsedHistoryRow[],
  kind: HistoryKind,
  currency: Currency
): Record<string, unknown>[] {
  if (parsed.some((row) => row.kind !== kind)) {
    throw new Error(`[tier-c] history row kind does not match ${kind}`)
  }

  // An individual copier row remains identifying even without its label.
  // Receipt-bound private publication handles it; public rendering never does.
  if (kind === 'copiers') return []

  // Keep the interactive result aligned with arena_records_page. Parser
  // internals, source identities, evidence claims, and RAW values stay private.
  return parsed.map((row) => {
    if (row.kind === 'position_history') {
      return {
        symbol: row.symbol,
        side: row.side,
        leverage: row.leverage,
        size: row.size,
        entry_price: row.entryPrice,
        exit_price: row.exitPrice,
        realized_pnl: row.realizedPnl,
        opened_at: row.openedAt,
        closed_at: row.closedAt,
        currency,
      }
    }
    if (row.kind === 'orders') {
      return {
        ts: row.ts,
        kind: row.orderKind,
        symbol: row.symbol,
        side: row.side,
        price: row.price,
        qty: row.qty,
        currency,
      }
    }
    if (row.kind === 'transfers') {
      return {
        ts: row.ts,
        direction: row.direction,
        asset: row.asset,
        amount: row.amount,
      }
    }
    throw new Error('[tier-c] copier row reached the public render mapper')
  })
}

/**
 * Heavy-tab surfaces (spec §2.4-3): positions / position_history / orders /
 * transfers / copiers — fetched only when the user opens that tab. History
 * previews remain partial and RAW-only. Copiers additionally commit private
 * rows before publishing an opaque readiness marker; no copier row or cache
 * payload enters Redis.
 *
 * Copier PII rule (spec §6): no individual copier row leaves the worker.
 * Full rows, including label, PnL, investment, duration, and identity, may
 * enter only the private copier table after the immutable RAW pointer exists.
 */
async function processHeavySurface(
  job: Job<TierCJobData>,
  src: TierCSource,
  traderId: number,
  traderMeta: Record<string, unknown> | null
): Promise<unknown> {
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

    let rows: Record<string, unknown>[] = []
    let rawPayload: unknown = null
    let rawPersisted = false
    let warmPayload: Record<string, unknown> | null = null

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
      const observedAt = bundle.pages.at(-1)?.fetchedAt ?? null
      if (observedAt === null || !Number.isFinite(Date.parse(observedAt))) {
        throw new Error('[tier-c] positions capture has no valid observation clock')
      }
      const positions = bundle.pages.flatMap((p) => adapter.parsePositions(p.payload, ctx))
      rows = positionRowsForRender(positions, src.currency)

      const configuredDelayHours = src.meta.positions_delay_hours
      const sourceAsOf =
        typeof configuredDelayHours === 'number' &&
        Number.isFinite(configuredDelayHours) &&
        configuredDelayHours >= 0
          ? new Date(Date.parse(observedAt) - configuredDelayHours * 3600_000).toISOString()
          : null
      warmPayload = {
        rows,
        nextCursor: null,
        sourceAsOf,
        observedAt,
        publishedAt: null,
      }
      await redis.set(resultKey, JSON.stringify(warmPayload), 'EX', 120)
      // positions_current.as_of remains a legacy NOT NULL clock. Persist the
      // observation as a fallback, but never label it sourceAsOf in the API.
      await publishPositions(src, traderId, positions, sourceAsOf ?? observedAt, positionEvidence)
    } else {
      const kind = surface as HistoryKind
      const copierVerifier =
        kind === 'copiers' ? (adapter.verifyCopierSnapshot?.(src) ?? null) : null
      const acquisition = await captureHistoryAcquisition({
        source: src,
        traderId,
        exchangeTraderId,
        kind,
        cursor: null,
        attemptStartedAt: scrapedAt,
        // A copier publication is a whole snapshot. Adapter-owned pagination
        // limits and terminal proof control its crawl; the interactive two-page
        // preview cap would make every deeper snapshot permanently partial.
        callerPageCap: kind === 'copiers' && copierVerifier !== null ? null : 2,
        stream: adapter.getHistory(session, src, exchangeTraderId, kind, null, traderMeta),
        terminalVerifier:
          kind === 'copiers'
            ? copierVerifier
              ? { contract: copierVerifier.contract, verify: copierVerifier.verifyTerminal }
              : undefined
            : (adapter.historyTerminalVerifier?.(src, kind) ?? undefined),
      })
      rawPayload = acquisition.pages
      const rawInput = { artifact: acquisition.artifact, sourceRunId: acquisition.sourceRunId }

      const termination = acquisition.artifact.termination
      const observedAt = acquisition.artifact.pages.at(-1)?.fetched_at ?? null

      if (kind === 'copiers') {
        if (copierVerifier === null) {
          // An unreviewed copier surface remains immutable generic RAW only.
          // It can never acquire the lane-bound copier_snapshot artifact role.
          await writeHistoryRawArtifact(rawInput, runHistoryTransaction)
          if (acquisition.error !== null) throw acquisition.error
          if (acquisition.artifact.pages.length === 0 || observedAt === null) {
            throw new Error('[tier-c] copier snapshot returned no upstream response page')
          }
          throw new Error('[tier-c] copier snapshot has no verified exhaustive terminal proof')
        }

        await publishCapturedVerifiedCopierSnapshot({
          acquisition,
          adapter,
          lane: 'tier_c',
          source: src,
          trader: {
            id: traderId,
            exchange_trader_id: exchangeTraderId,
            meta: traderMeta,
          },
        })
        const readyMarker = {
          contract: COPIER_READY_CONTRACT,
          completed: true,
          aggregateReady: true,
        }
        await redis.set(resultKey, JSON.stringify(readyMarker), 'EX', RESULT_TTL_SECONDS)
        return { traderId, surface, aggregateReady: true }
      }

      if (acquisition.error !== null) {
        await writeHistoryRawArtifact(rawInput, runHistoryTransaction)
        throw acquisition.error
      }

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
        sourceAsOf: null,
        observedAt,
        publishedAt: null,
        completeness: historyCompleteness,
      })

      let storageDurable = false
      let rawPointerDurable = false
      const renderPreviewWithRaw: IngestTransactionRunner = async (persistRawPointer) => {
        // The immutable audit pointer commits before any untrusted parser or
        // Redis work. Compatibility history remains preview-only and cannot
        // mutate typed facts, evidence cursors, or the warm profile cache.
        storageDurable = true
        const rawReceipt = await runHistoryTransaction(persistRawPointer)
        rawPointerDurable = true

        const parsed = acquisition.pages.flatMap((page) =>
          adapter.parseHistory(page.payload, kind, ctx)
        )

        rows = historyRowsForRender(parsed, kind, src.currency)
        await redis.set(resultKey, JSON.stringify(renderPayload()), 'EX', RESULT_TTL_SECONDS)
        return rawReceipt
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
    if (warmPayload === null) {
      throw new Error('[tier-c] heavy surface has no durable render payload')
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
      [traderId, timeframe, surface, src.profile_cache_ttl_seconds, JSON.stringify(warmPayload)]
    )

    return { traderId, surface, rows: rows.length }
  } finally {
    await session.close()
  }
}
