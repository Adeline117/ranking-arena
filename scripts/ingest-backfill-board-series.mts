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
import { validateLeaderboardRows } from '../lib/ingest/staging/validate'
import type {
  BoardSeriesBlock,
  ParseCtx,
  ParsedLeaderboardRow,
  RankingTimeframe,
  RawPage,
} from '../lib/ingest/core/types'

// Explicit operator env still wins, allowing a one-run session-pooler override.
config({ path: resolve(process.cwd(), 'worker/.env'), quiet: true, override: false })
config({ path: resolve(process.cwd(), '.env.local'), quiet: true, override: false })

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

interface ReplaySnapshot {
  id: number
  timeframe: number
  rawObjectId: number | null
  scrapedAt: string
  actualCount: number
  rawSourceId: number | null
  rawJobType: string | null
  rawTimeframe: number | null
  rawMeta: Record<string, unknown> | null
}

/** Latest passed snapshot per TF. Never skip a newer row just because RAW is absent. */
async function latestPassedSnapshots(sourceId: number): Promise<ReplaySnapshot[]> {
  const { rows } = await getIngestPool().query<{
    id: number
    timeframe: number
    raw_object_id: number | null
    scraped_at: string
    actual_count: number
    raw_source_id: number | null
    raw_job_type: string | null
    raw_timeframe: number | null
    raw_meta: Record<string, unknown> | null
  }>(
    `SELECT DISTINCT ON (ls.timeframe)
            ls.id, ls.timeframe, ls.raw_object_id, ls.scraped_at::text,
            ls.actual_count, ro.source_id AS raw_source_id,
            ro.job_type AS raw_job_type, ro.timeframe AS raw_timeframe,
            ro.meta AS raw_meta
       FROM arena.leaderboard_snapshots ls
       LEFT JOIN arena.raw_objects ro ON ro.id = ls.raw_object_id
      WHERE ls.source_id = $1 AND ls.count_check_passed
      ORDER BY ls.timeframe, ls.scraped_at DESC, ls.id DESC`,
    [sourceId]
  )
  return rows.map((r) => ({
    id: r.id,
    timeframe: r.timeframe,
    rawObjectId: r.raw_object_id,
    scrapedAt: new Date(r.scraped_at).toISOString(),
    actualCount: r.actual_count,
    rawSourceId: r.raw_source_id,
    rawJobType: r.raw_job_type,
    rawTimeframe: r.raw_timeframe,
    rawMeta: r.raw_meta,
  }))
}

/** Exact exchange_trader_id → trader id membership for one passed snapshot. */
async function snapshotTraderIdMap(snapshotId: number): Promise<Map<string, number>> {
  const { rows } = await getIngestPool().query<{ id: number; exchange_trader_id: string }>(
    `SELECT t.id, t.exchange_trader_id
       FROM arena.leaderboard_entries le
       JOIN arena.traders t ON t.id = le.trader_id
      WHERE le.snapshot_id = $1`,
    [snapshotId]
  )
  const m = new Map<string, number>()
  for (const r of rows) m.set(r.exchange_trader_id, r.id)
  return m
}

function setMatches(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  return left.size === right.size && [...left].every((value) => right.has(value))
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
      const snaps = await latestPassedSnapshots(src.id)
      const nativeTfs = [...new Set(nativeRankingTimeframes(src) as number[])].sort((a, b) => a - b)
      if (nativeTfs.length === 0) throw new Error(`[${slug}] has no native ranking timeframes`)
      const snapsByTf = new Map(snaps.map((snap) => [snap.timeframe, snap]))
      const missingTfs = nativeTfs.filter((timeframe) => !snapsByTf.has(timeframe))
      if (missingTfs.length > 0) {
        throw new Error(`[${slug}] missing passed RAW snapshots for ${missingTfs.join(',')}d`)
      }

      let totalPts = 0
      let totalTraders = 0
      const allSeries = new Map<string, BoardSeriesBlock[]>()
      const traderIds = new Map<string, number>()
      for (const timeframe of nativeTfs) {
        const snap = snapsByTf.get(timeframe)!
        if (
          snap.rawObjectId === null ||
          snap.rawSourceId !== src.id ||
          snap.rawJobType !== 'tier_a' ||
          snap.rawTimeframe !== timeframe
        ) {
          throw new Error(
            `[${slug}] ${timeframe}d latest passed snapshot ${snap.id} has an invalid RAW pointer`
          )
        }
        const rawPageCount = Number(snap.rawMeta?.pageCount)
        if (!Number.isInteger(rawPageCount) || rawPageCount <= 0) {
          throw new Error(`[${slug}] ${timeframe}d raw ${snap.rawObjectId} has no valid pageCount`)
        }
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
        const pageArr = Array.isArray(pages) ? (pages as Partial<RawPage>[]) : []
        if (pageArr.length !== rawPageCount) {
          throw new Error(
            `[${slug}] ${timeframe}d raw page mismatch: meta=${rawPageCount}, payload=${pageArr.length}`
          )
        }
        const merged = new Map<string, BoardSeriesBlock[]>()
        const parsedRows: ParsedLeaderboardRow[] = []
        const pageSize = src.page_size ?? 100
        for (const [index, page] of pageArr.entries()) {
          if (
            !page ||
            typeof page !== 'object' ||
            !Object.prototype.hasOwnProperty.call(page, 'payload') ||
            page.pageIndex !== index + 1
          ) {
            throw new Error(`[${slug}] ${timeframe}d raw page sequence invalid at index ${index}`)
          }
          const parsed = adapter.parseLeaderboard(page.payload, ctx)
          for (const row of parsed.rows) {
            parsedRows.push({ ...row, rank: (page.pageIndex - 1) * pageSize + row.rank })
          }
          const m = adapter.parseLeaderboardSeries(page.payload, ctx, timeframe as RankingTimeframe)
          for (const [id, blocks] of m) {
            if (blocks.some((block) => block.timeframe !== timeframe)) {
              throw new Error(`[${slug}] ${timeframe}d parser returned a cross-timeframe block`)
            }
            const ex = merged.get(id)
            if (ex) ex.push(...blocks)
            else merged.set(id, blocks)
          }
        }
        if (merged.size === 0) throw new Error(`[${slug}] ${timeframe}d parsed zero series`)
        const requiredFields = ((src.meta.required_fields as string[]) ?? []) as Array<
          keyof ParsedLeaderboardRow
        >
        const { valid } = validateLeaderboardRows(parsedRows, requiredFields)
        const snapshotTraders = await snapshotTraderIdMap(snap.id)
        if (valid.length !== snap.actualCount || snapshotTraders.size !== snap.actualCount) {
          throw new Error(
            `[${slug}] ${timeframe}d snapshot count mismatch: recorded=${snap.actualCount}, reparsed=${valid.length}, entries=${snapshotTraders.size}`
          )
        }
        const validIds = new Set(valid.map((row) => row.exchangeTraderId))
        const snapshotIds = new Set(snapshotTraders.keys())
        const seriesIds = new Set(merged.keys())
        if (!setMatches(validIds, snapshotIds) || !setMatches(seriesIds, snapshotIds)) {
          throw new Error(
            `[${slug}] ${timeframe}d identity mismatch: valid=${validIds.size}, entries=${snapshotIds.size}, series=${seriesIds.size}`
          )
        }
        for (const [id, traderId] of snapshotTraders) traderIds.set(id, traderId)
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
          `[${slug}] ${timeframe}d snapshot=${snap.id} raw=${snap.rawObjectId} ` +
            `scraped=${snap.scrapedAt} pages=${pageArr.length} rows=${snap.actualCount}: ` +
            `${prepared.rows.length} pts / ${prepared.traders} traders (preflight)`
        )
      }
      const combined = prepareBoardSeriesRows(allSeries, traderIds)
      if (combined.rows.length !== totalPts) {
        throw new Error(
          `[${slug}] combined key mismatch: per-tf=${totalPts}, combined=${combined.rows.length}`
        )
      }
      if (apply) {
        const written = await publishBoardSeries(src, allSeries, traderIds, {
          expectedLatestSnapshots: new Map(
            nativeTfs.map((timeframe) => {
              const snap = snapsByTf.get(timeframe)!
              return [
                timeframe,
                {
                  id: snap.id,
                  rawObjectId: snap.rawObjectId!,
                  scrapedAt: snap.scrapedAt,
                },
              ]
            })
          ),
        })
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
