/**
 * Tier B deep-profile crawl (spec §2.3-B): only the top
 * sources.deep_profile_topn per board, every 12-24h. These hot traders
 * stay cache-warm so the most-viewed profiles never trigger a live fetch.
 * Long-tail traders are NEVER crawled on a timer — that's Tier C.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug, profileTimeframes } from '@/lib/ingest/sources'
import { getAdapter, type SourceAdapter } from '@/lib/ingest/core/adapter'
import type { HistoryKind, ParseCtx, ParsedHistoryRow, SourceRow } from '@/lib/ingest/core/types'
import type { FetchSession } from '@/lib/ingest/fetch/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { roiCrossCheckOk, validateStats } from '@/lib/ingest/staging/validate'
import { getHistoryCursor, publishHistoryRows, publishProfile } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'

interface TopTrader {
  id: number
  exchange_trader_id: string
  meta: Record<string, unknown> | null
  /** timeframe → board headline ROI (for the spec §5.3 cross-check). */
  headline_rois: Record<string, number | null> | null
}

/**
 * Top-ranked traders from the latest PASSED snapshot of each timeframe.
 * NOTE: join entries on snapshot_id ONLY (indexed) — never on scraped_at
 * equality: pg timestamptz carries microseconds while values round-tripped
 * through JS Date are millisecond-truncated, so a ts-equality join silently
 * matches zero rows (the 2026-06-11 "no passed snapshots yet" bug).
 */
async function getTopTraders(sourceId: number, topN: number): Promise<TopTrader[]> {
  const { rows } = await getIngestPool().query<TopTrader>(
    `WITH latest AS (
       SELECT DISTINCT ON (timeframe) id AS snapshot_id
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND count_check_passed
        ORDER BY timeframe, scraped_at DESC
     )
     SELECT t.id, t.exchange_trader_id, t.meta,
            jsonb_object_agg(e.timeframe::text, e.headline_roi) AS headline_rois
       FROM latest l
       JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
       JOIN arena.traders t ON t.id = e.trader_id
      WHERE e.rank <= $2
      GROUP BY t.id, t.exchange_trader_id, t.meta`,
    [sourceId, topN]
  )
  return rows
}

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
}

/** History kinds this source can serve, per adapter capabilities. */
function historyKinds(adapter: SourceAdapter): HistoryKind[] {
  const kinds: HistoryKind[] = []
  if (adapter.capabilities.positionHistory) kinds.push('position_history')
  if (adapter.capabilities.orders) kinds.push('orders')
  if (adapter.capabilities.transfers) kinds.push('transfers')
  if (adapter.capabilities.copiers) kinds.push('copiers')
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
  for (const kind of historyKinds(adapter)) {
    const cursor = await getHistoryCursor(trader.id, kind)
    const rows: ParsedHistoryRow[] = []
    const rawPages: unknown[] = []

    for await (const page of adapter.getHistory(
      session,
      src,
      trader.exchange_trader_id,
      kind,
      cursor,
      trader.meta
    )) {
      rawPages.push(page)
      rows.push(...adapter.parseHistory(page.payload, kind, ctx))
    }
    if (rawPages.length === 0) continue

    await writeRawObject({
      sourceId: src.id,
      sourceSlug: src.slug,
      jobType: `history:${kind}`,
      traderId: trader.id,
      timeframe: null,
      payload: rawPages,
    })

    // New cursor = newest event ts seen (closed_at for positions, ts else);
    // never move it backwards.
    let newest: string | null = null
    for (const row of rows) {
      const ts = row.kind === 'position_history' ? row.closedAt : row.ts
      if (ts && (newest === null || ts > newest)) newest = ts
    }
    const newCursor = newest !== null && (cursor === null || newest > cursor) ? newest : null

    written += await publishHistoryRows(src, trader.id, kind, rows, newCursor)
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
  }
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') return empty

  const adapter = getAdapter(src.adapter_slug)
  if (!adapter.capabilities.profile) return empty

  const topTraders = shuffle(await getTopTraders(src.id, src.deep_profile_topn))
  if (topTraders.length === 0) {
    console.log(`[tier-b] ${src.slug}: no passed snapshots yet — nothing to crawl`)
    return empty
  }

  // native ∪ derived: derived 30/90 boards are synthesized from these
  // profile stats (spec §1.1-C), so Tier-B must crawl their TFs too.
  const timeframes = profileTimeframes(src)
  const session = await openSession(src)
  const result: TierBResult = { ...empty }

  try {
    for (const trader of topTraders) {
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
            jobType: 'tier_b',
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
          traderOk = true
        } catch (err) {
          result.errors += 1
          console.warn(
            `[tier-b] ${src.slug} trader ${trader.exchange_trader_id} ${timeframe}d failed:`,
            err instanceof Error ? err.message : err
          )
        }
      }
      if (traderOk) {
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

  console.log(
    `[tier-b] ${src.slug}: ${result.tradersCrawled}/${topTraders.length} traders, ` +
      `${result.surfacesFetched} surfaces, ${result.historyRowsWritten} history rows, ` +
      `${result.rejects} rejects, ${result.errors} errors`
  )
  return result
}
