/**
 * Tier D open-positions snapshot (spec §2.3-D): top sources.positions_topn
 * traders per board, every 1-2h, subject to source-disclosed staleness —
 * Bitget shows non-copiers a 1h-delayed view, so rows are stamped
 * as_of = scraped_at − meta.positions_delay_hours (spec §5.7).
 * Snapshot semantics: each trader's open positions are fully replaced.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug } from '@/lib/ingest/sources'
import { getAdapter } from '@/lib/ingest/core/adapter'
import type { ParseCtx } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { publishPositions } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'

interface TargetTrader {
  id: number
  exchange_trader_id: string
  meta: Record<string, unknown> | null
}

/**
 * Top-ranked traders from the latest PASSED snapshot of each timeframe.
 * Join on snapshot_id ONLY — never on scraped_at equality (JS Date
 * round-trips truncate pg microseconds; see tier-b for the full story).
 */
async function getPositionTargets(sourceId: number, topN: number): Promise<TargetTrader[]> {
  const { rows } = await getIngestPool().query<TargetTrader>(
    `WITH latest AS (
       SELECT DISTINCT ON (timeframe) id AS snapshot_id
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND count_check_passed
        ORDER BY timeframe, scraped_at DESC
     )
     SELECT DISTINCT t.id, t.exchange_trader_id, t.meta
       FROM latest l
       JOIN arena.leaderboard_entries e ON e.snapshot_id = l.snapshot_id
       JOIN arena.traders t ON t.id = e.trader_id
      WHERE e.rank <= $2
        AND (t.meta->>'claimed') IS DISTINCT FROM 'true'`,
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

export interface TierDResult {
  tradersCrawled: number
  positionsWritten: number
  errors: number
}

export async function processTierD(job: Job<TierJobData>): Promise<TierDResult> {
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active') return { tradersCrawled: 0, positionsWritten: 0, errors: 0 }

  const adapter = getAdapter(src.adapter_slug)
  if (!adapter.capabilities.positions) {
    return { tradersCrawled: 0, positionsWritten: 0, errors: 0 }
  }

  const targets = shuffle(await getPositionTargets(src.id, src.positions_topn))
  if (targets.length === 0) {
    console.log(`[tier-d] ${src.slug}: no passed snapshots yet — nothing to crawl`)
    return { tradersCrawled: 0, positionsWritten: 0, errors: 0 }
  }

  const delayHours = Number(src.meta.positions_delay_hours ?? 0) || 0
  // Tier-D can run for hours on large position sets. Its own stable profile
  // prevents that session from holding Tier A's warm default profile hostage.
  const session = await openSession(src, {
    profileLaneKey: 'tier-d',
    profileSuffix: 'tier-d',
  })
  const result: TierDResult = { tradersCrawled: 0, positionsWritten: 0, errors: 0 }

  try {
    for (const trader of targets) {
      try {
        const scrapedAt = new Date()
        const bundle = await adapter.getPositions(
          session,
          src,
          trader.exchange_trader_id,
          trader.meta
        )

        await writeRawObject({
          sourceId: src.id,
          sourceSlug: src.slug,
          jobType: 'tier_d',
          traderId: trader.id,
          timeframe: null,
          payload: bundle.pages,
        })

        const ctx: ParseCtx = {
          sourceSlug: src.slug,
          currency: src.currency,
          tfLabelMap: src.tf_label_map,
          scrapedAt: scrapedAt.toISOString(),
          meta: src.meta,
        }
        const positions = bundle.pages.flatMap((page) => adapter.parsePositions(page.payload, ctx))

        // Source-disclosed staleness (spec §5.7): Bitget −1h.
        const asOf = new Date(scrapedAt.getTime() - delayHours * 3_600_000).toISOString()
        await publishPositions(src, trader.id, positions, asOf)

        result.tradersCrawled += 1
        result.positionsWritten += positions.length
      } catch (err) {
        result.errors += 1
        console.warn(
          `[tier-d] ${src.slug} trader ${trader.exchange_trader_id} failed:`,
          err instanceof Error ? err.message : err
        )
      }
    }
  } finally {
    await session.close()
  }

  console.log(
    `[tier-d] ${src.slug}: ${result.tradersCrawled}/${targets.length} traders, ` +
      `${result.positionsWritten} open positions, ${result.errors} errors`
  )
  return result
}
