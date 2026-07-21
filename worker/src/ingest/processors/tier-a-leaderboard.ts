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
import { getAdapter } from '@/lib/ingest/core/adapter'
import type {
  BoardSeriesBlock,
  ParseCtx,
  ParsedLeaderboardRow,
  RawPage,
} from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { recordFieldInventory } from '@/lib/ingest/field-inventory'
import { validateLeaderboardRows } from '@/lib/ingest/staging/validate'
import { publishBoardSeries, publishLeaderboardSnapshot } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'
import { observationCycleId } from '../observation-cycle'

export interface TierAResult {
  timeframe: number
  actualCount: number
  rejects: number
  passed: boolean
  baselineUsed: number | null
  snapshotId: number
}

export async function processTierA(job: Job<TierJobData>): Promise<TierAResult[]> {
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') {
    console.log(`[tier-a] ${src.slug} is ${src.status} — skipping`)
    return []
  }

  const adapter = getAdapter(src.adapter_slug)
  const timeframes = nativeRankingTimeframes(src)
  const cycleId = observationCycleId(job, 'tier-a', src.slug)
  const results: TierAResult[] = []
  const failures: Array<{ timeframe: number; error: Error }> = []
  // Compute every potentially-throwing input before acquiring the source's
  // persistent-profile lease. Once acquired, the try/finally begins
  // immediately so future edits cannot strand the unsuffixed Tier-A lane.
  const session = await openSession(src)

  try {
    for (const timeframe of timeframes) {
      try {
        const scrapedAt = new Date().toISOString()
        const pages: RawPage[] = []
        for await (const page of adapter.listLeaderboard(session, src, timeframe)) {
          pages.push(page)
        }

        // RAW first — any downstream bug becomes a re-parse (spec §5.5).
        const rawReceipt = await writeRawObject({
          sourceId: src.id,
          sourceSlug: src.slug,
          jobType: 'tier_a',
          timeframe,
          payload: pages,
          meta: {
            pageCount: pages.length,
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
        failures.push({ timeframe, error })
        console.error(error.message)
      }
    }
  } finally {
    await session.close()
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.error),
      `[tier-a] ${src.slug}: ${failures.length}/${timeframes.length} native windows failed ` +
        `(${failures.map((failure) => `${failure.timeframe}d`).join(', ')}); ` +
        `${results.length} succeeded`
    )
  }

  return results
}
