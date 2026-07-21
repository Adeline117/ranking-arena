/**
 * Tier B deep-profile crawl (spec §2.3-B): only the top
 * sources.deep_profile_topn per board, every 12-24h. These hot traders
 * stay cache-warm so the most-viewed profiles never trigger a live fetch.
 * Long-tail traders are NEVER crawled on a timer — that's Tier C.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug, profileTimeframes } from '@/lib/ingest/sources'
import { getLatestPassedNativeCohort } from '@/lib/ingest/native-cohort'
import { getAdapter, type SourceAdapter } from '@/lib/ingest/core/adapter'
import { nextHistoryCursor } from '@/lib/ingest/core/history-cursor'
import { supportsSourceSurface } from '@/lib/ingest/core/surface-capabilities'
import {
  findIncompleteProfileWindow,
  IncompleteProfileWindowError,
} from '@/lib/ingest/core/profile-coverage'
import type { HistoryKind, ParseCtx, ParsedHistoryRow, SourceRow } from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
import { roiCrossCheckOk, validateStats } from '@/lib/ingest/staging/validate'
import { getHistoryCursor, publishHistoryRows, publishProfile } from '@/lib/ingest/serving/publish'
import { recordFieldInventory } from '@/lib/ingest/field-inventory'
import { fireAndForget, logger } from '@/lib/utils/logger'
import { getRegionQueue, INGEST_JOB, type TierJobData } from '../queues'

/**
 * Staleness filter (deadline-chunking, 2026-07-03): only traders NOT
 * deep-profiled since `stalerThan` are returned. The marker is a dedicated
 * arena.ingest_cursors row (kind 'tierb_profiled') written after each trader
 * whose requested timeframes reached a terminal success/quality-reject state.
 * trader_stats.as_of is NOT usable here because the
 * tier-A board upsert refreshes it every 2-5h, which would make everyone
 * look "fresh" and starve the deep crawl entirely.
 * The native-cohort helper applies this filter after selecting only declared
 * native PASSED top-N membership; derived boards must never feed Tier-B back
 * into themselves.
 */
/** Compatibility marker recording a terminal deep-profile attempt. */
const PROFILED_CURSOR_KIND = 'tierb_profiled'

async function markProfileAttempted(traderId: number): Promise<void> {
  await getIngestPool().query(
    `INSERT INTO arena.ingest_cursors (trader_id, kind, cursor_value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (trader_id, kind)
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
    [traderId, PROFILED_CURSOR_KIND, new Date().toISOString()]
  )
}

/**
 * Max continuation hops per chain: bounds a pathological slow-failing source
 * (nothing gets marked profiled → every continuation re-attempts the same
 * traders) to ~depth × deadline of wasted crawl per cadence instead of a
 * self-requeue loop that never ends.
 */
const MAX_CONT_DEPTH = 50

/** Fisher–Yates — never crawl ranks 1→N in perfect order (spec §4). */
function shuffle<T>(arr: T[]): T[] {
  const out = [...arr]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export interface TierBResult {
  tradersCrawled: number
  surfacesFetched: number
  historyRowsWritten: number
  rejects: number
  errors: number
  crossCheckFails: number
  /** Traders still stale when the deadline hit (0 = pass completed). */
  remaining: number
}

/** History kinds this source can serve, per adapter capabilities. */
function historyKinds(adapter: SourceAdapter, src: SourceRow): HistoryKind[] {
  const kinds: HistoryKind[] = []
  if (supportsSourceSurface(adapter, src, 'positionHistory')) kinds.push('position_history')
  if (supportsSourceSurface(adapter, src, 'orders')) kinds.push('orders')
  if (supportsSourceSurface(adapter, src, 'transfers')) kinds.push('transfers')
  if (supportsSourceSurface(adapter, src, 'copiers')) kinds.push('copiers')
  return kinds
}

/**
 * Incremental history pass for ONE trader within the same session (spec
 * §2.3 Histories): newest pages until cursor overlap, idempotent upsert by
 * dedupe_hash, cursor advanced to the newest row seen.
 */
async function crawlTraderHistories(
  session: FetchSession,
  adapter: SourceAdapter,
  src: SourceRow,
  trader: TopTrader,
  ctx: ParseCtx
): Promise<number> {
  let written = 0
  for (const kind of historyKinds(adapter, src)) {
    const cursor = await getHistoryCursor(trader.id, kind)
    const rawPages: unknown[] = []
    let fetchError: unknown = null

    try {
      for await (const page of adapter.getHistory(
        session,
        src,
        trader.exchange_trader_id,
        kind,
        cursor,
        trader.meta
      )) {
        rawPages.push(page)
      }
    } catch (error) {
      fetchError = error
    }

    if (rawPages.length > 0 || fetchError !== null) {
      await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: `history:${kind}`,
        traderId: trader.id,
        timeframe: null,
        payload: rawPages,
        meta: { fetch_failed: fetchError !== null },
      })
    }
    if (fetchError !== null) throw fetchError
    if (rawPages.length === 0) continue

    // RAW is durable before an incomplete or changed payload can be rejected.
    const rows: ParsedHistoryRow[] = rawPages.flatMap((rawPage) => {
      const page = rawPage as import('@/lib/ingest/core/types').RawPage
      return adapter.parseHistory(page.payload, kind, ctx)
    })

    written += await publishHistoryRows(src, trader.id, kind, rows, nextHistoryCursor(rows, cursor))
  }
  return written
}

export async function processTierB(job: Job<TierJobData>): Promise<TierBResult> {
  const empty: TierBResult = {
    tradersCrawled: 0,
    surfacesFetched: 0,
    historyRowsWritten: 0,
    rejects: 0,
    errors: 0,
    crossCheckFails: 0,
    remaining: 0,
  }
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') return empty

  const adapter = getAdapter(src.adapter_slug)
  if (!supportsSourceSurface(adapter, src, 'profile')) return empty

  // Deadline chunking (2026-07-03 slot-monopoly root fix): a full top-300
  // deep-profile pass ran 3-4h per source and, phase-locked across sources,
  // monopolized every bulk slot for hours (tier-A boards 17-32h stale).
  // BullMQ priority can't preempt an in-flight job, so the job itself must
  // yield: crawl only stale traders, stop at the wall-clock deadline, and
  // re-enqueue a CONTINUATION at the same priority. Higher-priority work
  // interleaves between chunks; the pass still completes because the
  // staleness marker (ingest_cursors) makes every chunk resume where the
  // previous one left off. Freshness window = half the tier-B cadence, so a
  // scheduler iteration overlapping a continuation chain just no-ops.
  const deadlineMs = Math.max(60_000, Number(src.meta.tier_b_deadline_ms ?? 600_000))
  const refreshMs = Math.max(3_600_000, (src.cadence_tier_b_seconds * 1000) / 2)
  const stalerThan = new Date(Date.now() - refreshMs)
  const contDepth = Number(job.data.contDepth ?? 0)

  const nativeCohort = await getLatestPassedNativeCohort(src, {
    excludeClaimed: true,
    profileCursor: { kind: PROFILED_CURSOR_KIND, stalerThan },
  })
  if (nativeCohort.missingTimeframes.length > 0) {
    logger.warn(
      `[tier-b] ${src.slug}: native cohort incomplete, missing PASSED board(s) ` +
        `[${nativeCohort.missingTimeframes.map((tf) => `${tf}d`).join(',')}]; ` +
        `crawling available native top-N only`
    )
  }

  const topTraders = shuffle(nativeCohort.traders)
  if (topTraders.length === 0) {
    if (nativeCohort.missingTimeframes.length === 0) {
      logger.info(`[tier-b] ${src.slug}: all top-${src.deep_profile_topn} fresh — nothing to crawl`)
    }
    return empty
  }

  // native ∪ derived: derived 30/90 boards are synthesized from these
  // profile stats (spec §1.1-C), so Tier-B must crawl their TFs too.
  const timeframes = profileTimeframes(src)
  // Tier A intentionally keeps the legacy unsuffixed profile (warm cookies).
  // Tier B owns a stable lane so a long profile crawl cannot collide with it.
  const session = await openSession(src, {
    profileLaneKey: 'tier-b',
    profileSuffix: 'tier-b',
  })
  const startedAt = Date.now()
  let attempted = 0
  const result: TierBResult = { ...empty }

  try {
    for (const trader of topTraders) {
      // Yield the slot once the budget is spent (always ≥1 trader of progress
      // so a chain can never spin without advancing).
      if (attempted > 0 && Date.now() - startedAt > deadlineMs) break
      attempted += 1
      let terminalTimeframes = 0
      let successfulTimeframes = 0
      let traderHadQualityReject = false
      let traderHadOperationalError = false
      for (const timeframe of timeframes) {
        try {
          const scrapedAt = new Date().toISOString()
          const bundle = await adapter.getProfile(
            session,
            src,
            trader.exchange_trader_id,
            timeframe,
            trader.meta,
            { intent: 'scheduled_full' }
          )

          const rawObjectId = (
            await writeRawObject({
              sourceId: src.id,
              sourceSlug: src.slug,
              jobType: 'tier_b',
              traderId: trader.id,
              timeframe,
              payload: bundle.pages,
            })
          ).id

          // Upstream field radar (P1): 1-in-50 traders sample the profile
          // payload shape. Fire-and-forget — never breaks the crawl.
          if (attempted % 50 === 1 && bundle.pages.length > 0) {
            fireAndForget(
              recordFieldInventory(src.id, 'tier_b', bundle.pages[0].payload),
              `tier-b-field-inventory:${src.slug}`
            )
          }

          const ctx: ParseCtx = {
            sourceSlug: src.slug,
            currency: src.currency,
            tfLabelMap: src.tf_label_map,
            scrapedAt,
            meta: src.meta,
          }
          // Parse the complete logical surface before validating or publishing
          // any page. One bad page must quarantine the whole bundle rather than
          // leave a partially-published profile.
          const parsedPages = bundle.pages.map((page) => ({
            page,
            profile: adapter.parseProfile(page.payload, ctx),
          }))
          const qualityRejects =
            parsedPages.length === 0
              ? [
                  {
                    reason: 'profile_payload_missing',
                    payload: {
                      source_slug: src.slug,
                      trader_id: trader.id,
                      exchange_trader_id: trader.exchange_trader_id,
                      timeframe,
                      scraped_at: scrapedAt,
                      page_count: 0,
                    },
                  },
                ]
              : parsedPages.flatMap(({ page, profile }) =>
                  (adapter.validateProfile?.(profile, ctx, timeframe, page.payload) ?? []).map(
                    (reject) => ({
                      reason: reject.reason,
                      payload: {
                        ...reject.payload,
                        source_slug: src.slug,
                        trader_id: trader.id,
                        exchange_trader_id: trader.exchange_trader_id,
                        timeframe,
                        scraped_at: scrapedAt,
                        page_index: page.pageIndex,
                      },
                    })
                  )
                )

          if (qualityRejects.length > 0) {
            // The immutable RAW pointer exists. A durable reject makes this
            // timeframe terminal without allowing any serving/cache mutation.
            await recordStagingRejects(src.id, rawObjectId, qualityRejects)
            result.rejects += qualityRejects.length
            result.surfacesFetched += 1
            terminalTimeframes += 1
            traderHadQualityReject = true
            continue
          }

          for (const { profile } of parsedPages) {
            const incomplete = findIncompleteProfileWindow(profile)
            if (incomplete) {
              // RAW is already durable. Merge audit extras only, then surface
              // a real failure so this trader is not marked fresh.
              await publishProfile(src, trader.id, profile, { fullSeries: true })
              throw new IncompleteProfileWindowError(incomplete.timeframe, incomplete.reason)
            }
            const requiredFields = ((src.meta.profile_required_fields as string[]) ?? []) as Array<
              keyof import('@/lib/ingest/core/types').ParsedStats
            >
            const { valid, rejects } = validateStats(profile.stats, requiredFields)
            result.rejects += rejects.length

            // Cross-check (spec §5.3): board headline ROI must match the
            // profile ROI for the same TF within tolerance — catches stale
            // caches / wrong-timeframe clicks. Log-and-count, never block:
            // the board value stays authoritative for ranking either way.
            const headline = trader.headline_rois?.[String(timeframe)] ?? null
            const profileRoi = valid.find((b) => b.timeframe === timeframe)?.roi ?? null
            if (roiCrossCheckOk(headline, profileRoi) === false) {
              result.crossCheckFails += 1
              console.warn(
                `[tier-b] ${src.slug} ${trader.exchange_trader_id} ${timeframe}d ` +
                  `ROI cross-check FAIL: board=${headline} profile=${profileRoi}`
              )
            }

            await publishProfile(
              src,
              trader.id,
              { ...profile, stats: valid },
              { fullSeries: true } // Tier B = ranked/topN → full series (spec §13.1)
            )
          }
          result.surfacesFetched += 1
          successfulTimeframes += 1
          terminalTimeframes += 1
        } catch (err) {
          traderHadOperationalError = true
          result.errors += 1
          console.warn(
            `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} ${timeframe}d failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
      const allTimeframesTerminal =
        timeframes.length > 0 && terminalTimeframes === timeframes.length
      const allTimeframesSuccessful =
        allTimeframesTerminal &&
        !traderHadQualityReject &&
        !traderHadOperationalError &&
        successfulTimeframes === timeframes.length

      if (allTimeframesTerminal && !traderHadOperationalError) {
        // Quality rejects are terminal for this pass: throttle the next attempt
        // so continuation jobs cannot hot-loop on a permanently bad upstream
        // payload. The compatibility cursor kind remains `tierb_profiled`.
        await markProfileAttempted(trader.id)
      }

      if (allTimeframesSuccessful) {
        result.tradersCrawled += 1
        // Histories ride the same session right after the profile (spec
        // §2.3): incremental, cursor-overlap stop, idempotent upserts.
        try {
          const ctx: ParseCtx = {
            sourceSlug: src.slug,
            currency: src.currency,
            tfLabelMap: src.tf_label_map,
            scrapedAt: new Date().toISOString(),
            meta: src.meta,
          }
          result.historyRowsWritten += await crawlTraderHistories(
            session,
            adapter,
            src,
            trader,
            ctx
          )
        } catch (err) {
          result.errors += 1
          console.warn(
            `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} histories failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
    }
  } finally {
    await session.close()
  }

  result.remaining = topTraders.length - attempted
  if (result.remaining > 0) {
    if (contDepth < MAX_CONT_DEPTH) {
      // Same priority as the scheduler registration (6) — a continuation must
      // never jump the tier order (that inversion was the 2026-07-03 wedge).
      // Depth-scoped jobId preserves dedup within one hop while letting the
      // currently-active continuation enqueue its successor. Reusing one
      // source-only id made BullMQ return the active job as a duplicate, so
      // continuation chains silently stopped after their first hop.
      try {
        const nextDepth = contDepth + 1
        await getRegionQueue(src.fetch_region).add(
          INGEST_JOB.TIER_B,
          { sourceSlug: src.slug, contDepth: nextDepth } satisfies TierJobData,
          {
            priority: 6,
            jobId: `tierb-cont-${src.slug}-${nextDepth}`,
            delay: 5_000,
            removeOnComplete: true,
            removeOnFail: { age: 3600 },
          }
        )
      } catch (err) {
        console.warn(
          `[tier-b] ${src.slug} continuation enqueue failed (next cadence covers it):`,
          err instanceof Error ? err.message : err
        )
      }
    } else {
      console.warn(
        `[tier-b] ${src.slug}: continuation depth ${contDepth} hit cap ${MAX_CONT_DEPTH} ` +
          `with ${result.remaining} still stale — stopping chain (next cadence retries)`
      )
    }
  }

  logger.info(
    `[tier-b] ${src.slug}: ${result.tradersCrawled}/${attempted} attempted ok ` +
      `(${result.remaining} stale remaining${result.remaining > 0 ? `, continuation depth ${contDepth + 1}` : ''}), ` +
      `${result.surfacesFetched} surfaces, ${result.historyRowsWritten} history rows, ` +
      `${result.rejects} rejects, ${result.crossCheckFails} xcheck-fails, ${result.errors} errors`
  )
  return result
}
