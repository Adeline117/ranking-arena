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
import type { ParseCtx } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { validateStats } from '@/lib/ingest/staging/validate'
import { publishProfile } from '@/lib/ingest/serving/publish'
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
      ORDER BY r.rank
      OFFSET $4 LIMIT $5`,
    [sourceId, topN, backfillTopN, offset, limit]
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
     SELECT count(*)::int AS n FROM ranked WHERE rank > $2 AND rank <= $3`,
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
  const total = await bandSize(src.id, src.deep_profile_topn, backfillTopN)
  if (total === 0) return empty

  let offset = await readCursor(src.id)
  if (offset >= total) offset = 0 // wrap to refresh from the band top

  const traders = await getBandTraders(src.id, src.deep_profile_topn, backfillTopN, offset, batch)
  const nextOffset = offset + traders.length >= total ? 0 : offset + traders.length

  const timeframes = profileTimeframes(src)
  const session = await openSession(src)
  const result: TierBSeriesResult = {
    ...empty,
    cursorFrom: offset,
    cursorTo: nextOffset,
    bandSize: total,
  }

  try {
    for (const trader of traders) {
      let traderOk = false
      for (const timeframe of timeframes) {
        try {
          const scrapedAt = new Date().toISOString()
          const bundle = await adapter.getProfile(
            session,
            src,
            trader.exchange_trader_id,
            timeframe,
            trader.meta
          )

          await writeRawObject({
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
          for (const page of bundle.pages) {
            const profile = adapter.parseProfile(page.payload, ctx)
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
          traderOk = true
        } catch (err) {
          result.errors += 1
          console.warn(
            `[tier-b-series] ${src.slug} ${trader.exchange_trader_id} ${timeframe}d failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
      if (traderOk) result.tradersCrawled += 1
    }
  } finally {
    await session.close()
  }

  // Advance the sweep cursor only after the batch completes — a crashed run
  // re-attempts the same band slice (idempotent upserts make that safe).
  await writeCursor(src.id, nextOffset)

  console.log(
    `[tier-b-series] ${src.slug}: ${result.tradersCrawled}/${traders.length} traders ` +
      `(band ${src.deep_profile_topn + 1}-${backfillTopN}, ${total} total, ` +
      `offset ${offset}→${nextOffset}), ${result.seriesWritten} series pts, ` +
      `${result.rejects} rejects, ${result.errors} errors`
  )
  return result
}
