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
 * Default is read-only. Applying writes requires both --apply and at least one
 * explicit adapter slug, for example:
 *   npx tsx scripts/ingest-backfill-board-series.mts binance_web3
 *   npx tsx scripts/ingest-backfill-board-series.mts --apply binance_web3
 */
import { config } from 'dotenv'
import { resolve } from 'node:path'
import { getIngestPool, closeIngestPool } from '../lib/ingest/db'
import { getSourceBySlug, nativeRankingTimeframes } from '../lib/ingest/sources'
import { getAdapter } from '../lib/ingest/core/adapter'
import '../lib/ingest/adapters/register'
import { readRawObject } from '../lib/ingest/raw'
import { prepareBoardSeriesRows, publishBoardSeries } from '../lib/ingest/serving/publish'
import type { BoardSeriesBlock, ParseCtx, RankingTimeframe } from '../lib/ingest/core/types'

// Explicit operator env still wins, allowing a one-run session-pooler override.
config({ path: resolve(process.cwd(), 'worker/.env'), quiet: true })
config({ path: resolve(process.cwd(), '.env.local'), quiet: true })

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
): Promise<Array<{ timeframe: number; rawObjectId: number; scrapedAt: string }>> {
  const { rows } = await getIngestPool().query<{
    timeframe: number
    raw_object_id: number
    scraped_at: string
  }>(
    `SELECT DISTINCT ON (timeframe) timeframe, raw_object_id, scraped_at
       FROM arena.leaderboard_snapshots
      WHERE source_id = $1 AND count_check_passed AND raw_object_id IS NOT NULL
      ORDER BY timeframe, scraped_at DESC`,
    [sourceId]
  )
  return rows.map((r) => ({
    timeframe: r.timeframe,
    rawObjectId: r.raw_object_id,
    scrapedAt: new Date(r.scraped_at).toISOString(),
  }))
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
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const unknownFlags = args.filter((arg) => arg.startsWith('--') && arg !== '--apply')
  if (unknownFlags.length > 0) throw new Error(`unknown flags: ${unknownFlags.join(', ')}`)
  const argSlugs = args.filter((arg) => !arg.startsWith('--'))
  if (apply && argSlugs.length === 0) {
    throw new Error('--apply requires at least one explicit adapter slug')
  }
  const adapterSlugs = argSlugs.length > 0 ? argSlugs : SERIES_SLUGS
  console.log(`[mode] ${apply ? 'APPLY' : 'DRY-RUN'} adapters=${adapterSlugs.join(',')}`)

  for (const adapterSlug of adapterSlugs) {
    const adapter = getAdapter(adapterSlug)
    if (!adapter.parseLeaderboardSeries) {
      throw new Error(`${adapterSlug}: no parseLeaderboardSeries`)
    }
    const sourceSlugs = await sourceSlugsForAdapter(adapterSlug)
    if (sourceSlugs.length === 0) throw new Error(`${adapterSlug}: no active serving sources`)
    for (const slug of sourceSlugs) {
      const src = await getSourceBySlug(slug)
      const traderIds = await traderIdMap(src.id)
      const snaps = await latestPassedSnapshots(src.id)
      const nativeTfs = [...new Set(nativeRankingTimeframes(src) as number[])].sort((a, b) => a - b)
      const snapsByTf = new Map(snaps.map((snap) => [snap.timeframe, snap]))
      const missingTfs = nativeTfs.filter((timeframe) => !snapsByTf.has(timeframe))
      if (missingTfs.length > 0) {
        throw new Error(`[${slug}] missing passed RAW snapshots for ${missingTfs.join(',')}d`)
      }

      let totalPts = 0
      let totalTraders = 0
      const allSeries = new Map<string, BoardSeriesBlock[]>()
      for (const timeframe of nativeTfs) {
        const snap = snapsByTf.get(timeframe)!
        const pages = await readRawObject(snap.rawObjectId)
        const ctx: ParseCtx = {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt: snap.scrapedAt,
          meta: src.meta,
        }
        // RAW for tier_a is an array of pages (RawPage[]); each page.payload
        // is the source's leaderboard JSON the parser consumes.
        const pageArr = Array.isArray(pages) ? (pages as Array<{ payload?: unknown }>) : []
        if (pageArr.length === 0) {
          throw new Error(`[${slug}] ${timeframe}d raw ${snap.rawObjectId} has no pages`)
        }
        const merged = new Map<string, BoardSeriesBlock[]>()
        for (const page of pageArr) {
          const payload =
            page && typeof page === 'object' && 'payload' in page ? page.payload : page
          const m = adapter.parseLeaderboardSeries(payload, ctx, timeframe as RankingTimeframe)
          for (const [id, blocks] of m) {
            const ex = merged.get(id)
            if (ex) ex.push(...blocks)
            else merged.set(id, blocks)
          }
        }
        if (merged.size === 0) throw new Error(`[${slug}] ${timeframe}d parsed zero series`)
        const mappedTraders = [...merged.keys()].filter((id) => traderIds.has(id)).length
        if (mappedTraders !== merged.size) {
          throw new Error(
            `[${slug}] ${timeframe}d trader mapping incomplete: parsed=${merged.size}, mapped=${mappedTraders}`
          )
        }
        const prepared = prepareBoardSeriesRows(merged, traderIds)
        if (prepared.rows.length === 0 || prepared.traders !== merged.size) {
          throw new Error(
            `[${slug}] ${timeframe}d preparation incomplete: parsed=${merged.size}, prepared=${prepared.traders}, points=${prepared.rows.length}`
          )
        }
        for (const [id, blocks] of merged) {
          const existing = allSeries.get(id)
          if (existing) existing.push(...blocks)
          else allSeries.set(id, [...blocks])
        }
        totalPts += prepared.rows.length
        totalTraders += prepared.traders
        console.log(
          `[${slug}] ${timeframe}d: ${prepared.rows.length} pts / ${prepared.traders} traders (preflight)`
        )
      }
      const combined = prepareBoardSeriesRows(allSeries, traderIds)
      if (combined.rows.length !== totalPts) {
        throw new Error(
          `[${slug}] combined key mismatch: per-tf=${totalPts}, combined=${combined.rows.length}`
        )
      }
      if (apply) {
        const written = await publishBoardSeries(src, allSeries, traderIds)
        if (written.points !== combined.rows.length || written.traders !== combined.traders) {
          throw new Error(
            `[${slug}] post-write mismatch: expected=${combined.rows.length}/${combined.traders}, actual=${written.points}/${written.traders}`
          )
        }
      }
      console.log(
        `[${slug}] ${apply ? 'APPLIED' : 'DRY-RUN PASS'}: ${totalPts} pts across ${totalTraders} trader-TFs (${combined.traders} unique traders)`
      )
    }
  }

  await closeIngestPool()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
