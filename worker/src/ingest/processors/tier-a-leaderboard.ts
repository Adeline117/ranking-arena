/**
 * Tier A leaderboard crawl (spec §2.3-A): every 4-6h per source, all native
 * ranking timeframes. Flow per TF:
 *   fetch pages (JSON replay) → RAW object → pure-parse → staging validate
 *   → publish gate (count check; failed snapshots never reach serving).
 *
 * This is the bulk of the product: every ranked trader gets a traders row,
 * leaderboard_entries and headline stats so profile first screens render
 * with zero on-demand fetching.
 */

import type { Job } from 'bullmq'
import { getSourceBySlug, nativeRankingTimeframes } from '@/lib/ingest/sources'
import { getAdapter, type SourceAdapter } from '@/lib/ingest/core/adapter'
import {
  RANKING_TIMEFRAMES,
  type BoardSeriesBlock,
  type ParseCtx,
  type ParsedLeaderboardRow,
  type RankingTimeframe,
  type RawPage,
} from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import type { LeaderboardCapture } from '@/lib/ingest/fetch/capture'
import { buildLeaderboardAcquisitionManifest } from '@/lib/ingest/acquisition-manifest'
import { writeRawObject } from '@/lib/ingest/raw'
import { recordFieldInventory } from '@/lib/ingest/field-inventory'
import { validateLeaderboardRows } from '@/lib/ingest/staging/validate'
import { publishBoardSeries, publishLeaderboardSnapshot } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'
import { observationCycleId } from '../observation-cycle'
import { resolveDeployedSha } from '@/worker/src/ingest/heartbeat'

export interface TierAResult {
  timeframe: number
  actualCount: number
  rejects: number
  passed: boolean
  baselineUsed: number | null
  snapshotId: number
}

type TierAAcquisition =
  | { kind: 'capture'; capture: LeaderboardCapture }
  | { kind: 'legacy'; pages: RawPage[] }

async function acquireLeaderboard(
  adapter: SourceAdapter,
  session: Parameters<SourceAdapter['listLeaderboard']>[0],
  src: Parameters<SourceAdapter['listLeaderboard']>[1],
  timeframe: RankingTimeframe
): Promise<TierAAcquisition> {
  if (adapter.captureLeaderboard) {
    return {
      kind: 'capture',
      capture: await adapter.captureLeaderboard(session, src, timeframe),
    }
  }

  const pages: RawPage[] = []
  for await (const page of adapter.listLeaderboard(session, src, timeframe)) pages.push(page)
  return { kind: 'legacy', pages }
}

function verifiedRunnerGitSha(): string | null {
  const value = resolveDeployedSha()
  return /^[0-9a-f]{40}$/.test(value) ? value : null
}

function completedTimeframesFrom(value: unknown): RankingTimeframe[] {
  if (!Array.isArray(value)) return []
  const completed = new Set(value.filter((timeframe) => RANKING_TIMEFRAMES.includes(timeframe)))
  return RANKING_TIMEFRAMES.filter((timeframe) => completed.has(timeframe))
}

class TierACheckpointPersistenceError extends Error {
  constructor(sourceSlug: string, timeframe: RankingTimeframe, options: { cause: unknown }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause)
    super(`checkpoint persistence failed for ${sourceSlug} ${timeframe}d: ${detail}`, options)
    this.name = 'TierACheckpointPersistenceError'
  }
}

async function persistCompletedTimeframe(
  job: Job<TierJobData>,
  persistedJobData: TierJobData,
  completedTimeframes: ReadonlySet<RankingTimeframe>,
  timeframe: RankingTimeframe,
  sourceSlug: string
): Promise<TierJobData> {
  const nextCompleted = completedTimeframesFrom([...completedTimeframes, timeframe])
  const nextData: TierJobData = {
    ...persistedJobData,
    completedTimeframes: nextCompleted,
  }

  try {
    await job.updateData(nextData)
    return nextData
  } catch (cause) {
    // BullMQ mutates job.data before its Redis command resolves. Restore the
    // last acknowledged value so a later checkpoint can never accidentally
    // persist this unconfirmed window. The caller treats this as fatal rather
    // than continuing to another timeframe.
    job.data = persistedJobData
    throw new TierACheckpointPersistenceError(sourceSlug, timeframe, { cause })
  }
}

export async function processTierA(job: Job<TierJobData>): Promise<TierAResult[]> {
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') {
    console.log(`[tier-a] ${src.slug} is ${src.status} — skipping`)
    return []
  }

  const timeframes = nativeRankingTimeframes(src)
  const completedTimeframes = new Set(
    completedTimeframesFrom(job.data.completedTimeframes).filter((timeframe) =>
      timeframes.includes(timeframe)
    )
  )
  const pendingTimeframes = timeframes.filter((timeframe) => !completedTimeframes.has(timeframe))
  if (completedTimeframes.size > 0) {
    console.log(
      `[tier-a] ${src.slug}: resuming job; skipping completed windows ` +
        [...completedTimeframes].map((timeframe) => `${timeframe}d`).join(', ')
    )
  }
  if (pendingTimeframes.length === 0) return []

  const adapter = getAdapter(src.adapter_slug)
  const cycleId = observationCycleId(job, 'tier-a', src.slug)
  // Freeze provenance before the first upstream request. A long-running crawl
  // must not bind later timeframes to a different checkout/deployment SHA.
  const runnerGitSha = adapter.captureLeaderboard ? verifiedRunnerGitSha() : null
  const results: TierAResult[] = []
  const failures: Array<{ timeframe: number; error: Error }> = []
  let terminalFailure: { error: unknown } | null = null
  let sessionCloseFailure: Error | null = null
  let persistedJobData: TierJobData = { ...job.data }
  // Compute every potentially-throwing input before acquiring the source's
  // persistent-profile lease. Once acquired, the try/finally begins
  // immediately so future edits cannot strand the unsuffixed Tier-A lane.
  const session = await openSession(src)

  try {
    for (const timeframe of pendingTimeframes) {
      try {
        const scrapedAt = new Date().toISOString()
        const acquisition = await acquireLeaderboard(adapter, session, src, timeframe)
        const pages =
          acquisition.kind === 'capture' ? [...acquisition.capture.parsePages] : acquisition.pages
        const rawPages =
          acquisition.kind === 'capture'
            ? acquisition.capture.sourcePages.map((sourcePage) => sourcePage.rawPage)
            : acquisition.pages

        // RAW first — any downstream bug becomes a re-parse (spec §5.5).
        const rawReceipt = await writeRawObject({
          sourceId: src.id,
          sourceSlug: src.slug,
          jobType: 'tier_a',
          timeframe,
          payload: rawPages,
          meta: {
            pageCount: rawPages.length,
            ...(cycleId ? { observation_cycle_id: cycleId } : {}),
          },
        })
        const rawObjectId = rawReceipt.id

        // Upstream field radar (P1): sample the first page's shape while it's
        // still in memory (RAW blobs aren't SQL-queryable). Fire-and-forget —
        // observation must never break the crawl.
        if (pages.length > 0) {
          recordFieldInventory(src.id, 'tier_a', pages[0].payload).catch(() => {})
        }

        const ctx: ParseCtx = {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt,
          meta: src.meta,
        }

        // Parse pages and re-anchor positional in-page ranks globally.
        const pageSize = src.page_size ?? 100
        const rows: ParsedLeaderboardRow[] = []
        // Board-level "free series" (spec §13.1): merged across pages, keyed by
        // exchange_trader_id. Only populated for sources whose board embeds a
        // per-trader sparkline (okx/toobit/xt/blofin/bitunix/binance_web3) — adapters without
        // parseLeaderboardSeries contribute nothing and pay zero cost.
        const boardSeries = new Map<string, BoardSeriesBlock[]>()
        for (const page of pages) {
          const parsed = adapter.parseLeaderboard(page.payload, ctx)
          for (const row of parsed.rows) {
            rows.push({ ...row, rank: (page.pageIndex - 1) * pageSize + row.rank })
          }
          if (adapter.parseLeaderboardSeries) {
            const pageSeries = adapter.parseLeaderboardSeries(page.payload, ctx, timeframe)
            for (const [traderId, blocks] of pageSeries) {
              const existing = boardSeries.get(traderId)
              if (existing) existing.push(...blocks)
              else boardSeries.set(traderId, blocks)
            }
          }
        }

        const requiredFields = ((src.meta.required_fields as string[]) ?? []) as Array<
          keyof ParsedLeaderboardRow
        >
        const { valid, rejects } = validateLeaderboardRows(rows, requiredFields)

        if (acquisition.kind === 'capture') {
          const capture = acquisition.capture
          const built = buildLeaderboardAcquisitionManifest({
            source: {
              id: src.id,
              slug: src.slug,
              adapter_slug: src.adapter_slug,
              configured_page_size: src.page_size,
              configured_pagination_kind: src.pagination_kind,
            },
            surface: 'tier_a_leaderboard',
            timeframe,
            started_at: scrapedAt,
            completed_at: new Date().toISOString(),
            runner_git_sha: runnerGitSha,
            observation_cycle_id: cycleId,
            capture_evidence_state: 'verified',
            termination_reason: capture.terminationReason,
            capture_config: capture.captureConfig,
            source_pages: capture.sourcePages.map((sourcePage) => ({
              raw_page: sourcePage.rawPage,
              source_row_count: sourcePage.sourceRowCount,
              request_sha256: sourcePage.requestSha256,
              http_status: sourcePage.httpStatus,
              pagination_position: sourcePage.paginationPosition,
              source_reports: sourcePage.sourceReports,
            })),
            parse_pages: capture.parsePages,
            parser_transformation: capture.parserTransformation,
            accepted_population: valid.length,
            rejected_row_count: rejects.length,
          })
          if (
            built.manifest.assessment.acquisition_state !== 'complete' ||
            built.manifest.assessment.population_state !== 'verified'
          ) {
            throw new Error(
              `acquisition trust gate FAILED: acquisition=` +
                `${built.manifest.assessment.acquisition_state}, population=` +
                `${built.manifest.assessment.population_state}, source_run=${built.sourceRunId}`
            )
          }
        }

        const result = await publishLeaderboardSnapshot({
          src,
          timeframe,
          rows: valid,
          rejects,
          rawObjectId,
          observationCycleId: cycleId ?? undefined,
        })

        const status = result.published ? 'PUBLISHED' : 'GATED'
        console.log(
          `[tier-a] ${src.slug} ${timeframe}d: ${valid.length} rows ` +
            `(${rejects.length} rejected, baseline=${result.verdict.baselineUsed}, ` +
            `deviation=${result.verdict.deviationPct?.toFixed(1) ?? '–'}%) → ${status}`
        )
        if (!result.published) {
          // Keep this window out of serving, but do not sacrifice the other
          // native windows. The aggregate error after the loop still fails the
          // BullMQ job for retry and operator visibility.
          throw new Error(
            `count check FAILED: actual=${valid.length} ` +
              `baseline=${result.verdict.baselineUsed} — snapshot ${result.snapshotId} ` +
              `recorded, serving keeps last good`
          )
        }

        // Board-level free series (spec §13.1): every ranked trader gets a
        // chart with no extra fetch — closes the long-tail series gap that
        // otherwise waits on Tier-B topN / on-demand Tier-C.
        if (boardSeries.size > 0) {
          const seriesOut = await publishBoardSeries(src, boardSeries, result.traderIds, {
            expectedLatestSnapshots: new Map([
              [
                timeframe,
                {
                  id: result.snapshotId,
                  rawObjectId,
                  scrapedAt: new Date(result.scrapedAt).toISOString(),
                },
              ],
            ]),
          })
          console.log(
            `[tier-a] ${src.slug} ${timeframe}d board series: ` +
              `${seriesOut.points} pts for ${seriesOut.traders} traders`
          )
        }

        // Bot boards (spec §11.5): shadow trader rows are published above
        // like any board; additionally upsert arena.bots from the
        // adapter-normalized fields (traderMeta.bot).
        if (src.trader_kind_scope === 'bot') {
          const { publishBots } = await import('@/lib/ingest/serving/publish-bots')
          const bots = await publishBots(src, valid, result.traderIds)
          console.log(`[tier-a] ${src.slug} ${timeframe}d bots upserted: ${bots.written}`)
        }

        // (compat→trader_latest write removed 2026-06-15) The score chain now runs
        // on arena directly (compute-leaderboard reads arena_score_inputs, not
        // trader_latest), so the compat bridge is orphaned and trader_latest is
        // being dropped. publish() above already wrote arena.* — the canonical source.

        // This is deliberately the LAST awaited side effect in one window.
        // A retry may skip the window only after RAW + snapshot + optional
        // board-series + optional bot publication have all completed. Persist
        // after every window so a worker restart loses at most the in-flight TF.
        persistedJobData = await persistCompletedTimeframe(
          job,
          persistedJobData,
          completedTimeframes,
          timeframe,
          src.slug
        )
        completedTimeframes.add(timeframe)

        results.push({
          timeframe,
          actualCount: valid.length,
          rejects: rejects.length,
          passed: result.verdict.passed,
          baselineUsed: result.verdict.baselineUsed,
          snapshotId: result.snapshotId,
        })
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        const error = new Error(`[tier-a] ${src.slug} ${timeframe}d failed: ${detail}`, { cause })
        console.error(error.message)
        // A checkpoint failure is infrastructure-level and must fail closed.
        // Continuing could let a later updateData call persist a checkpoint
        // whose Redis acknowledgement was lost for this window.
        if (cause instanceof TierACheckpointPersistenceError) throw error
        failures.push({ timeframe, error })
      }
    }
  } catch (error) {
    terminalFailure = { error }
  } finally {
    try {
      await session.close()
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      sessionCloseFailure = new Error(`[tier-a] ${src.slug} session close failed: ${detail}`, {
        cause,
      })
    }
  }

  if (terminalFailure !== null) {
    if (sessionCloseFailure !== null) {
      const processingError =
        terminalFailure.error instanceof Error
          ? terminalFailure.error
          : new Error(String(terminalFailure.error))
      throw new AggregateError(
        [processingError, sessionCloseFailure],
        `[tier-a] ${src.slug}: processing and session close both failed`
      )
    }
    throw terminalFailure.error
  }

  if (failures.length > 0) {
    const errors = failures.map((failure) => failure.error)
    if (sessionCloseFailure !== null) errors.push(sessionCloseFailure)
    throw new AggregateError(
      errors,
      `[tier-a] ${src.slug}: ${failures.length}/${timeframes.length} native windows failed ` +
        `(${failures.map((failure) => `${failure.timeframe}d`).join(', ')}); ` +
        `${results.length} succeeded${sessionCloseFailure ? '; session close failed' : ''}`
    )
  }

  if (sessionCloseFailure !== null) throw sessionCloseFailure

  return results
}
