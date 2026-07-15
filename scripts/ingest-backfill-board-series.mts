/**
 * One-shot backfill of board-level "free series" from STORED RAW (spec §5.5
 * re-parse): for each source whose adapter exposes parseLeaderboardSeries,
 * take the latest passed snapshot per native TF, re-read its raw_object,
 * decode the inline board sparkline, and publish into arena.trader_series.
 *
 * This warms coverage for the long tail IMMEDIATELY without waiting for the
 * next Tier-A crawl and without a worker restart (pure re-parse of payloads
 * already on disk). Subsequent Tier-A crawls keep it warm automatically.
 *
 * Usage: npx tsx scripts/ingest-backfill-board-series.mts [slug ...]
 */
import { getIngestPool, closeIngestPool } from '../lib/ingest/db'
import { getSourceBySlug, nativeRankingTimeframes } from '../lib/ingest/sources'
import { getAdapter } from '../lib/ingest/core/adapter'
import '../lib/ingest/adapters/register'
import { readRawObject } from '../lib/ingest/raw'
import { publishBoardSeries } from '../lib/ingest/serving/publish'
import type { BoardSeriesBlock, ParseCtx, RankingTimeframe } from '../lib/ingest/core/types'

const SERIES_SLUGS = ['okx', 'toobit', 'xt', 'blofin', 'bitunix', 'binance_web3']

async function sourceSlugsForAdapter(adapterSlug: string): Promise<string[]> {
  const { rows } = await getIngestPool().query<{ slug: string }>(
    `SELECT slug FROM arena.sources
      WHERE adapter_slug = $1 AND status = 'active' AND serving_mode <> 'legacy'
      ORDER BY slug`,
    [adapterSlug]
  )
  return rows.map((r) => r.slug)
}

/** Latest passed snapshot per TF with its raw_object_id + the trader id map. */
async function latestPassedSnapshots(
  sourceId: number
): Promise<Array<{ timeframe: number; rawObjectId: number }>> {
  const { rows } = await getIngestPool().query<{ timeframe: number; raw_object_id: number }>(
    `SELECT DISTINCT ON (timeframe) timeframe, raw_object_id
       FROM arena.leaderboard_snapshots
      WHERE source_id = $1 AND count_check_passed AND raw_object_id IS NOT NULL
      ORDER BY timeframe, scraped_at DESC`,
    [sourceId]
  )
  return rows.map((r) => ({ timeframe: r.timeframe, rawObjectId: r.raw_object_id }))
}

/** exchange_trader_id → arena.traders.id for one source (the whole board). */
async function traderIdMap(sourceId: number): Promise<Map<string, number>> {
  const { rows } = await getIngestPool().query<{ id: number; exchange_trader_id: string }>(
    `SELECT id, exchange_trader_id FROM arena.traders WHERE source_id = $1`,
    [sourceId]
  )
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.exchange_trader_id, r.id)
  return m
}

async function main() {
  const argSlugs = process.argv.slice(2)
  const adapterSlugs = argSlugs.length > 0 ? argSlugs : SERIES_SLUGS

  for (const adapterSlug of adapterSlugs) {
    const adapter = getAdapter(adapterSlug)
    if (!adapter.parseLeaderboardSeries) {
      console.log(`[skip] ${adapterSlug}: no parseLeaderboardSeries`)
      continue
    }
    const sourceSlugs = await sourceSlugsForAdapter(adapterSlug)
    for (const slug of sourceSlugs) {
      const src = await getSourceBySlug(slug)
      const traderIds = await traderIdMap(src.id)
      const snaps = await latestPassedSnapshots(src.id)
      const nativeTfs = new Set(nativeRankingTimeframes(src) as number[])

      let totalPts = 0
      let totalTraders = 0
      for (const snap of snaps) {
        if (!nativeTfs.has(snap.timeframe)) continue
        let pages: unknown
        try {
          pages = await readRawObject(snap.rawObjectId)
        } catch (err) {
          console.warn(
            `[${slug}] ${snap.timeframe}d raw ${snap.rawObjectId} read failed:`,
            err instanceof Error ? err.message : err
          )
          continue
        }
        const ctx: ParseCtx = {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt: new Date().toISOString(),
          meta: src.meta,
        }
        // RAW for tier_a is an array of pages (RawPage[]); each page.payload
        // is the source's leaderboard JSON the parser consumes.
        const pageArr = Array.isArray(pages) ? (pages as Array<{ payload?: unknown }>) : []
        const merged = new Map<string, BoardSeriesBlock[]>()
        for (const page of pageArr) {
          const payload =
            page && typeof page === 'object' && 'payload' in page ? page.payload : page
          const m = adapter.parseLeaderboardSeries(payload, ctx, snap.timeframe as RankingTimeframe)
          for (const [id, blocks] of m) {
            const ex = merged.get(id)
            if (ex) ex.push(...blocks)
            else merged.set(id, blocks)
          }
        }
        if (merged.size === 0) continue
        const out = await publishBoardSeries(src, merged, traderIds)
        totalPts += out.points
        totalTraders += out.traders
        console.log(`[${slug}] ${snap.timeframe}d: ${out.points} pts / ${out.traders} traders`)
      }
      console.log(`[${slug}] DONE: ${totalPts} pts across ${totalTraders} trader-TFs`)
    }
  }

  await closeIngestPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
