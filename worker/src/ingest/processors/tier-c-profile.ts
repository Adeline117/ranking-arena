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
import { nextHistoryCursor } from '@/lib/ingest/core/history-cursor'
import {
  findIncompleteProfileWindow,
  IncompleteProfileWindowError,
} from '@/lib/ingest/core/profile-coverage'
import type { ProfileQualityReject } from '@/lib/ingest/core/profile-quality'
import type { Currency, ParseCtx, ParsedHistoryRow, ParsedPosition } from '@/lib/ingest/core/types'
import type { HistoryCompleteness } from '@/lib/data/serving/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { captureHistoryAcquisition } from '@/lib/ingest/history-acquisition'
import {
  writeCopierSnapshotRawArtifact,
  writePositionHistoryRawArtifact,
  writeRawObject,
  type IngestTransactionRunner,
} from '@/lib/ingest/raw'
import { buildCopierSnapshotArtifact } from '@/lib/ingest/copier-snapshot-artifact'
import { publishCopierSnapshotInTransaction } from '@/lib/ingest/serving/copier-snapshot-publish'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
import {
  getHistoryCursor,
  publishHistoryRows,
  publishPositions,
  publishProfile,
} from '@/lib/ingest/serving/publish'
import { getIngestPool } from '@/lib/ingest/db'
import { tierCResultKey, type TierCJobData } from '../queues'
import { runHistoryTransaction } from '../history-transaction'

const RESULT_TTL_SECONDS = 120
const COPIER_SNAPSHOT_READY_CONTRACT = 'arena.tier-c.copier-snapshot-ready@1'

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
  // to every surface, including forged/stale queue jobs that bypass the route.
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
    //    existing trader. RAW was
    //    written before parsing and is deliberately not duplicated here.
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
  kind: import('@/lib/ingest/core/types').HistoryKind,
  currency: Currency
): Record<string, unknown>[] {
  if (parsed.some((row) => row.kind !== kind)) {
    throw new Error(`[tier-c] history row kind does not match ${kind}`)
  }

  // Copier records remain private aggregation inputs. Even after stripping a
  // label, one row still reveals an individual's PnL/investment/duration.
  if (kind === 'copiers') return []

  // Emit an explicit snake_case allowlist aligned with arena_records_page.
  // Parser internals, RAW payloads, natural identities, and claim evidence
  // stay in the worker/private persistence path.
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
 * transfers / copiers — fetched only when the user opens that tab. Public row
 * surfaces keep the render-before-persist preview contract. Copiers invert the
 * order: private rows commit first, then an opaque readiness marker wakes the
 * route so it can re-read the aggregate RPC; no copier profile_cache is written.
 *
 * Copier PII rule (spec §6): no individual copier row leaves the worker.
 * Full rows (including label, PnL, investment, duration, and dedupe identity)
 * only reach receipt-bound arena.copier_snapshot_rows, which has no public
 * access.
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
    let historyCompleteness: HistoryCompleteness | undefined
    let sourceAsOf: string | null = null
    let observedAt: string | null = null
    const renderPayload = () => ({
      rows,
      nextCursor: null,
      sourceAsOf,
      observedAt,
      publishedAt: null,
      ...(historyCompleteness ? { completeness: historyCompleteness } : {}),
    })

    if (surface === 'positions') {
      const bundle = await adapter.getPositions(session, src, exchangeTraderId, traderMeta)
      rawPayload = bundle.pages
      observedAt = bundle.pages.at(-1)?.fetchedAt ?? null
      if (observedAt === null) {
        throw new Error('[tier-c] positions capture returned no evidence page')
      }
      const positions = bundle.pages.flatMap((p) => adapter.parsePositions(p.payload, ctx))
      rows = positionRowsForRender(positions, src.currency)

      const configuredDelayHours = src.meta.positions_delay_hours
      if (
        typeof configuredDelayHours === 'number' &&
        Number.isFinite(configuredDelayHours) &&
        configuredDelayHours >= 0 &&
        Number.isFinite(Date.parse(observedAt))
      ) {
        sourceAsOf = new Date(
          Date.parse(observedAt) - configuredDelayHours * 3600_000
        ).toISOString()
      }
      await redis.set(resultKey, JSON.stringify(renderPayload()), 'EX', 120)
      // positions_current.as_of is legacy NOT NULL storage. Until its schema is
      // split, persist the observation clock as fallback but never expose that
      // fallback to clients as sourceAsOf.
      await publishPositions(src, traderId, positions, sourceAsOf ?? observedAt)
    } else {
      const kind = surface as import('@/lib/ingest/core/types').HistoryKind
      // Copier snapshots must be rebuilt from an untruncated capture, while
      // receipt-bound position history is an immutable RAW acquisition. Neither
      // surface may consult or advance the legacy serving cursor.
      const cursor =
        kind === 'copiers' || kind === 'position_history'
          ? null
          : await getHistoryCursor(traderId, kind)
      if (kind === 'position_history') {
        const acquisition = await captureHistoryAcquisition({
          source: src,
          traderId,
          exchangeTraderId,
          kind,
          cursor,
          attemptStartedAt: new Date().toISOString(),
          callerPageCap: 2,
          stream: adapter.getHistory(session, src, exchangeTraderId, kind, cursor, traderMeta),
          terminalVerifier: adapter.historyTerminalVerifier?.(src, kind) ?? undefined,
        })
        rawPayload = acquisition.pages
        const rawInput = { artifact: acquisition.artifact, sourceRunId: acquisition.sourceRunId }

        if (acquisition.error !== null) {
          await writePositionHistoryRawArtifact(rawInput, runHistoryTransaction)
          throw acquisition.error
        }

        const termination = acquisition.artifact.termination
        observedAt = acquisition.artifact.pages.at(-1)?.fetched_at ?? null
        // Tier-C is an interactive preview lane. Even a verifier-confirmed
        // one-page exhaustion does not prove the requested 7/30/90-day window,
        // so the render contract must remain partial and rank-ineligible.
        historyCompleteness = {
          state: 'partial',
          reason: 'interactive_preview',
          evidenceState: termination.evidence_state,
          scanTerminalState: termination.scan_terminal_state,
          blockerReasons: [...termination.blocker_reasons],
        }

        let storageDurable = false
        let rawPointerDurable = false
        const renderPreviewWithRaw: IngestTransactionRunner = async (persistRawPointer) => {
          // The writer calls this only after the immutable artifact is in
          // Storage. Tier-C remains preview-only: publish its RAW audit pointer
          // before rendering, but never write typed rows or advance a cursor.
          storageDurable = true
          const receipt = await runHistoryTransaction(persistRawPointer)
          rawPointerDurable = true
          const parsed = acquisition.pages.flatMap((page) =>
            adapter.parseHistory(page.payload, kind, ctx)
          )
          rows = historyRowsForRender(parsed, kind, src.currency)
          await redis.set(resultKey, JSON.stringify(renderPayload()), 'EX', 120)
          return receipt
        }

        try {
          await writePositionHistoryRawArtifact(rawInput, renderPreviewWithRaw)
        } catch (cause) {
          if (storageDurable && !rawPointerDurable) {
            try {
              await writePositionHistoryRawArtifact(rawInput, runHistoryTransaction)
            } catch (rawCause) {
              throw new AggregateError(
                [
                  cause instanceof Error ? cause : new Error(String(cause)),
                  rawCause instanceof Error ? rawCause : new Error(String(rawCause)),
                ],
                '[tier-c] history publication failure and RAW audit persistence both failed'
              )
            }
          }
          throw cause
        }
        rawPersisted = true
      } else {
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
        observedAt = pages.at(-1)?.fetchedAt ?? null

        if (kind === 'copiers') {
          if (fetchError !== null || observedAt === null) {
            // Failed/empty captures remain diagnostic RAW only. They cannot
            // satisfy the page-bearing trusted artifact or wake a public read.
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
                capture_rejected: observedAt === null ? 'no_evidence_page' : null,
              },
            })
            rawPersisted = true
            if (fetchError !== null) throw fetchError
            throw new Error('[tier-c] copier capture returned no evidence page')
          }

          const artifact = buildCopierSnapshotArtifact({
            src,
            traderId,
            exchangeTraderId,
            lane: 'tier_c',
            requestTimeframe: timeframe,
            pages,
            callerLimited,
          })
          const rawReceipt = await writeCopierSnapshotRawArtifact(
            { artifact },
            runHistoryTransaction
          )
          rawPersisted = true
          const parsed = pages.flatMap((page) => adapter.parseHistory(page.payload, kind, ctx))

          // PostgreSQL commits the immutable receipt and all private rows as
          // one authority statement. Only that successful commit may wake the
          // route; the marker contains no person-level data or evidence IDs.
          await runHistoryTransaction((transaction) =>
            publishCopierSnapshotInTransaction(transaction, {
              artifact,
              rawReceipt,
              rows: parsed,
            })
          )
          const readyMarker = {
            contract: COPIER_SNAPSHOT_READY_CONTRACT,
            completed: true,
            snapshotReady: true,
          }
          await redis.set(resultKey, JSON.stringify(readyMarker), 'EX', RESULT_TTL_SECONDS)
          return { traderId, surface, snapshotReady: true }
        }

        // Non-ranking history surfaces retain the compatibility RAW path.
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

        const parsed = pages.flatMap((page) => adapter.parseHistory(page.payload, kind, ctx))
        const nextCursor = callerLimited ? null : nextHistoryCursor(parsed, cursor)

        rows = historyRowsForRender(parsed, kind, src.currency)

        await redis.set(resultKey, JSON.stringify(renderPayload()), 'EX', RESULT_TTL_SECONDS)

        await publishHistoryRows(src, traderId, kind, parsed, nextCursor)
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
      [traderId, timeframe, surface, src.profile_cache_ttl_seconds, JSON.stringify(renderPayload())]
    )

    return { traderId, surface, rows: rows.length }
  } finally {
    await session.close()
  }
}
