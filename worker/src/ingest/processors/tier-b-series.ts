/**
 * Tier B-S — series backfill (spec §13.1 long-tail coverage).
 *
 * The problem: Tier-B deep-crawls only the top `deep_profile_topn` (≈300) of
 * each board, while serving boards rank thousands. Every ranked trader beyond
 * topN has a chart-less profile until an on-demand Tier-C fetch (per page
 * view). For sources whose series live ONLY on the profile page (no inline
 * board sparkline — bybit, hyperliquid, binance, mexc, bitget, ...), the long
 * tail stays cold.
 *
 * The fix: a SLOW, BOUNDED backfill that crawls JUST the profile surface
 * (stats + series — NOT positions/orders/histories, the expensive heavy
 * surfaces) for ranked traders in the band (deep_profile_topn,
 * series_backfill_topn]. Each run processes at most `series_backfill_batch`
 * traders starting from a stored rank cursor, then advances the cursor; over
 * many slow runs it sweeps the whole band, then loops to refresh. Coverage
 * grows over days without blowing the rate budget.
 *
 * Config (arena.sources.meta):
 *   series_backfill_topn   number  — upper rank bound; absent ⇒ tier disabled
 *   series_backfill_batch  number  — traders per run (default 150)
 * Cursor: arena.ingest_cursors (trader_id = -source_id sentinel, kind
 *   'series_backfill') stores the next rank offset to resume from.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug, profileTimeframes } from '@/lib/ingest/sources'
import { getAdapter } from '@/lib/ingest/core/adapter'
import {
  findIncompleteProfileWindow,
  IncompleteProfileWindowError,
} from '@/lib/ingest/core/profile-coverage'
import type { ParseCtx } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { recordStagingRejects } from '@/lib/ingest/staging/rejects'
import { validateStats } from '@/lib/ingest/staging/validate'
import { publishProfile } from '@/lib/ingest/serving/publish'
import { logger } from '@/lib/logger'
import type { TierJobData } from '../queues'

const DEFAULT_BATCH = 150
/** Cursor rows for the backfill use a per-source sentinel trader id so they
 *  never collide with real (positive) trader ids in arena.ingest_cursors. */
const CURSOR_KIND = 'series_backfill'

interface BandTrader {
  id: number
  exchange_trader_id: string
  meta: Record<string, unknown> | null
  rank: number
}

/**
 * Ranked traders in the band (topN, backfillTopN], ordered by best rank seen
 * across the latest passed snapshot of each TF, starting AFTER `offset`.
 * One trader = one row (min rank across TFs) so we never crawl a trader twice
 * per sweep.
 */
async function getBandTraders(
  sourceId: number,
  topN: number,
  backfillTopN: number,
  offset: number,
  limit: number
): Promise<BandTrader[]> {
  const { rows } = await getIngestPool().query<BandTrader>(
    `WITH latest AS (
       SELECT DISTINCT ON (timeframe) id AS snapshot_id
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND count_check_passed
        ORDER BY timeframe, scraped_at DESC
     ),
     ranked AS (
       SELECT e.trader_id, min(e.rank) AS rank
         FROM latest l
         JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
        GROUP BY e.trader_id
     )
     SELECT t.id, t.exchange_trader_id, t.meta, r.rank
       FROM ranked r
       JOIN arena.traders t ON t.id = r.trader_id
      WHERE r.rank > $2 AND r.rank <= $3
        AND (t.meta->>'claimed') IS DISTINCT FROM 'true'
      ORDER BY r.rank
      OFFSET $4 LIMIT $5`,
    [sourceId, topN, backfillTopN, offset, limit]
  )
  return rows
}

/**
 * Newcomer fast-path (2026-07-09): band traders with NO series at all — a new
 * trader entering rank 300-3000 otherwise waits a full sweep cycle (2-4 days
 * on big boards) for their first chart. Each run front-loads a few of these
 * ahead of the cursor batch, so newcomers get series the first night. Ordered
 * by rank (most-visible first). The cursor is NOT advanced for these.
 */
async function getNeverCrawledBandTraders(
  sourceId: number,
  topN: number,
  backfillTopN: number,
  limit: number
): Promise<BandTrader[]> {
  const { rows } = await getIngestPool().query<BandTrader>(
    `WITH latest AS (
       SELECT DISTINCT ON (timeframe) id AS snapshot_id
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND count_check_passed
        ORDER BY timeframe, scraped_at DESC
     ),
     ranked AS (
       SELECT e.trader_id, min(e.rank) AS rank
         FROM latest l
         JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
        GROUP BY e.trader_id
     )
     SELECT t.id, t.exchange_trader_id, t.meta, r.rank
       FROM ranked r
       JOIN arena.traders t ON t.id = r.trader_id
      WHERE r.rank > $2 AND r.rank <= $3
        AND (t.meta->>'claimed') IS DISTINCT FROM 'true'
        AND NOT EXISTS (SELECT 1 FROM arena.trader_series ts WHERE ts.trader_id = t.id)
        -- A terminal quality reject intentionally writes no serving series.
        -- Cool its newcomer fast-path attempt so the same stopped upstream
        -- chart is not fetched every scheduler tick; the main rank cursor can
        -- still retry it on its normal sweep.
        AND NOT EXISTS (
          SELECT 1
            FROM arena.raw_objects ro
           WHERE ro.source_id = $1
             AND ro.job_type = 'tier_b_series'
             AND ro.trader_id = t.id
             AND ro.fetched_at > now() - interval '24 hours'
        )
      ORDER BY r.rank
      LIMIT $4`,
    [sourceId, topN, backfillTopN, limit]
  )
  return rows
}

async function bandSize(sourceId: number, topN: number, backfillTopN: number): Promise<number> {
  const { rows } = await getIngestPool().query<{ n: number }>(
    `WITH latest AS (
       SELECT DISTINCT ON (timeframe) id AS snapshot_id
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND count_check_passed
        ORDER BY timeframe, scraped_at DESC
     ),
     ranked AS (
       SELECT e.trader_id, min(e.rank) AS rank
         FROM latest l
         JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
        GROUP BY e.trader_id
     )
     SELECT count(*)::int AS n
       FROM ranked r
       JOIN arena.traders t ON t.id = r.trader_id
      WHERE r.rank > $2 AND r.rank <= $3
        AND (t.meta->>'claimed') IS DISTINCT FROM 'true'`,
    [sourceId, topN, backfillTopN]
  )
  return rows[0]?.n ?? 0
}

async function readCursor(sourceId: number): Promise<number> {
  const { rows } = await getIngestPool().query<{ cursor_value: string }>(
    `SELECT cursor_value FROM arena.ingest_cursors WHERE trader_id = $1 AND kind = $2`,
    [-sourceId, CURSOR_KIND]
  )
  const v = rows[0]?.cursor_value
  const n = v == null ? 0 : Number(v)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

async function writeCursor(sourceId: number, offset: number): Promise<void> {
  await getIngestPool().query(
    `INSERT INTO arena.ingest_cursors (trader_id, kind, cursor_value, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (trader_id, kind)
     DO UPDATE SET cursor_value = EXCLUDED.cursor_value, updated_at = now()`,
    [-sourceId, CURSOR_KIND, String(offset)]
  )
}

export interface TierBSeriesResult {
  tradersCrawled: number
  surfacesFetched: number
  seriesWritten: number
  rejects: number
  errors: number
  cursorFrom: number
  cursorTo: number
  bandSize: number
}

export async function processTierBSeries(job: Job<TierJobData>): Promise<TierBSeriesResult> {
  const empty: TierBSeriesResult = {
    tradersCrawled: 0,
    surfacesFetched: 0,
    seriesWritten: 0,
    rejects: 0,
    errors: 0,
    cursorFrom: 0,
    cursorTo: 0,
    bandSize: 0,
  }
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') return empty

  const backfillTopN = Number(src.meta.series_backfill_topn ?? 0)
  if (!backfillTopN || backfillTopN <= src.deep_profile_topn) {
    // Not configured for this source (or band is empty) — no-op.
    return empty
  }
  const adapter = getAdapter(src.adapter_slug)
  if (!adapter.capabilities.profile) return empty

  const batch = Math.max(1, Number(src.meta.series_backfill_batch ?? DEFAULT_BATCH))
  // Wall-clock budget (root fix 2026-06-16): series backfill is the LOWEST
  // priority tier (9) but its per-job work (batch × 3 TF profile crawls) ran
  // 20-40 min and monopolized all main-pool slots — BullMQ priority can't
  // preempt an in-flight job, so core Tier-A/D starved behind it (1027-job
  // wedge). Bounding the job to a deadline makes it ALWAYS yield its slot
  // quickly; the cursor advances by the traders actually attempted, so the next
  // iteration resumes seamlessly. This caps slot-hold structurally regardless
  // of batch/board size. Tunable via meta; default 120s.
  //
  // Deadline MUST stay < the BullMQ lockDuration (180s, ingest-worker.ts): if it
  // equals the lock, a slow trader can push the run past the lock before the
  // deadline fires between-traders, the stalled-checker kills the job, and the
  // post-loop cursor write never runs (root cause of the 2026-07-07 cursor bug,
  // now also defended by the per-trader write below). Keep this headroom.
  const deadlineMs = Math.max(30_000, Number(src.meta.series_backfill_deadline_ms ?? 120_000))
  const total = await bandSize(src.id, src.deep_profile_topn, backfillTopN)
  if (total === 0) return empty

  let offset = await readCursor(src.id)
  if (offset >= total) offset = 0 // wrap to refresh from the band top

  const traders = await getBandTraders(src.id, src.deep_profile_topn, backfillTopN, offset, batch)

  // Newcomer fast-path: front-load a few never-crawled band traders (see
  // getNeverCrawledBandTraders). Deduped against the cursor batch; flagged so
  // cursor accounting below counts ONLY cursor-batch traders.
  const newcomerLimit = Math.max(0, Number(src.meta.series_backfill_newcomers ?? 5))
  const newcomers =
    newcomerLimit > 0
      ? await getNeverCrawledBandTraders(src.id, src.deep_profile_topn, backfillTopN, newcomerLimit)
      : []
  const cursorIds = new Set(traders.map((t) => t.id))
  const work: Array<{ trader: BandTrader; fromCursor: boolean }> = [
    ...newcomers
      .filter((t) => !cursorIds.has(t.id))
      .map((trader) => ({ trader, fromCursor: false })),
    ...traders.map((trader) => ({ trader, fromCursor: true })),
  ]

  const timeframes = profileTimeframes(src)
  // Own profile dir: a concurrent long tier-A crawl on the same slug holds
  // profiles/<slug>'s Chrome ProcessSingleton for hours — bybit_mt5 backfill
  // died 100% ("Failed to create a ProcessSingleton", 90 errors/run) whenever
  // its giant board crawl was running (2026-07-09).
  const session = await openSession(src, {
    profileLaneKey: 'tier-b-series',
    profileSuffix: 'series',
  })
  const startedAt = Date.now()
  let attempted = 0
  // Cursor advances only for cursor-batch traders — newcomers ride for free.
  let cursorAttempted = 0
  const result: TierBSeriesResult = {
    ...empty,
    cursorFrom: offset,
    cursorTo: offset,
    bandSize: total,
  }

  try {
    for (const { trader, fromCursor } of work) {
      // Yield the slot once the budget is spent (but always make ≥1 trader of
      // progress so the cursor never stalls). The next iteration continues from
      // the advanced cursor.
      if (attempted > 0 && Date.now() - startedAt > deadlineMs) {
        logger.info(
          `[tier-b-series] ${src.slug}: budget ${deadlineMs}ms hit after ${attempted}/${work.length} traders — yielding slot`
        )
        break
      }
      attempted += 1
      if (fromCursor) cursorAttempted += 1
      let traderHadSuccess = false
      let traderAllTimeframesOk = true
      for (const timeframe of timeframes) {
        try {
          const scrapedAt = new Date().toISOString()
          const bundle = await adapter.getProfile(
            session,
            src,
            trader.exchange_trader_id,
            timeframe,
            trader.meta,
            { intent: 'series_only' }
          )

          const rawObjectId = await writeRawObject({
            sourceId: src.id,
            sourceSlug: src.slug,
            jobType: 'tier_b_series',
            traderId: trader.id,
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
          // One logical surface is all-or-nothing: parse every page before any
          // quality validation or serving publication so a bad later page can
          // never leave an earlier page partially published.
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
            await recordStagingRejects(src.id, rawObjectId, qualityRejects)
            result.rejects += qualityRejects.length
            result.surfacesFetched += 1
            traderAllTimeframesOk = false
            continue
          }

          for (const { profile } of parsedPages) {
            const incomplete = findIncompleteProfileWindow(profile)
            if (incomplete) {
              await publishProfile(src, trader.id, profile, { fullSeries: true })
              throw new IncompleteProfileWindowError(incomplete.timeframe, incomplete.reason)
            }
            const requiredFields = ((src.meta.profile_required_fields as string[]) ?? []) as Array<
              keyof import('@/lib/ingest/core/types').ParsedStats
            >
            const { valid, rejects } = validateStats(profile.stats, requiredFields)
            result.rejects += rejects.length
            // Ranked traders deserve a full chart (spec §13.1); maintenance
            // downsample/retention bounds storage over time as usual.
            await publishProfile(src, trader.id, { ...profile, stats: valid }, { fullSeries: true })
            result.seriesWritten += profile.series.reduce((n, s) => n + s.points.length, 0)
          }
          result.surfacesFetched += 1
          traderHadSuccess = true
        } catch (err) {
          traderAllTimeframesOk = false
          result.errors += 1
          console.warn(
            `[tier-b-series] ${src.slug} ${trader.exchange_trader_id} ${timeframe}d failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
      if (traderHadSuccess && traderAllTimeframesOk) result.tradersCrawled += 1

      // Incremental cursor persistence (defense-in-depth, 2026-07-07): write
      // progress after EACH trader, not just once post-loop. NOTE: the actual
      // ROOT CAUSE of the "cursor never persisted → band head re-crawled forever
      // → long tail never reached" bug (bitget_spot: 3559 crawls / 32 distinct
      // traders; ingest_cursors had ZERO series_backfill rows) was a FK
      // violation — writeCursor's negative sentinel trader_id=-sourceId broke
      // ingest_cursors_trader_id_fkey → traders(id), fixed by migration
      // 20260707003925. This per-trader write is the belt-and-suspenders half:
      // the worker restarts often (↺100/3d), so persisting progress per trader
      // (not per batch) keeps a mid-run kill from losing the sweep position.
      // Cheap (batch≈30), idempotent upserts. See
      // docs/SERIES_BACKFILL_CURSOR_FIX_PLAN.md.
      const soFar = offset + cursorAttempted
      await writeCursor(src.id, soFar >= total ? 0 : soFar)
    }
  } finally {
    await session.close()
  }

  // Advance the cursor by cursor-batch traders ACTUALLY attempted this run
  // (may be < batch when the wall-clock budget cut the run short) — a crashed
  // run re-attempts the same slice (idempotent upserts make that safe). Wrap
  // at band end. Newcomer fast-path traders never advance the cursor.
  // (Redundant with the per-trader write above on a clean run; retained as the
  // final authority and to cover the attempted===0 / empty-batch case.)
  const nextOffset = offset + cursorAttempted >= total ? 0 : offset + cursorAttempted
  result.cursorTo = nextOffset
  await writeCursor(src.id, nextOffset)

  logger.info(
    `[tier-b-series] ${src.slug}: ${result.tradersCrawled}/${attempted} traders ` +
      `(band ${src.deep_profile_topn + 1}-${backfillTopN}, ${total} total, ` +
      `offset ${offset}→${nextOffset}), ${result.seriesWritten} series pts, ` +
      `${result.rejects} rejects, ${result.errors} errors`
  )
  return result
}
