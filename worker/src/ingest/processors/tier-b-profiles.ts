/**
 * Tier B deep-profile crawl (spec §2.3-B): only the top
 * sources.deep_profile_topn per board, every 12-24h. These hot traders
 * stay cache-warm so the most-viewed profiles never trigger a live fetch.
 * Long-tail traders are NEVER crawled on a timer — that's Tier C.
 */

import type { Job } from 'bullmq'
import { getIngestPool } from '@/lib/ingest/db'
import { getSourceBySlug, nativeRankingTimeframes } from '@/lib/ingest/sources'
import { getAdapter } from '@/lib/ingest/core/adapter'
import type { ParseCtx } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { validateStats } from '@/lib/ingest/staging/validate'
import { publishProfile } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'

interface TopTrader {
  id: number
  exchange_trader_id: string
}

/** Top-ranked traders from the latest PASSED snapshot of each timeframe. */
async function getTopTraders(sourceId: number, topN: number): Promise<TopTrader[]> {
  const { rows } = await getIngestPool().query<TopTrader>(
    `WITH latest AS (
       SELECT DISTINCT ON (timeframe) id AS snapshot_id, scraped_at
         FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND count_check_passed
        ORDER BY timeframe, scraped_at DESC
     )
     SELECT DISTINCT t.id, t.exchange_trader_id
       FROM latest l
       JOIN arena.leaderboard_entries e
         ON e.snapshot_id = l.snapshot_id AND e.scraped_at = l.scraped_at
       JOIN arena.traders t ON t.id = e.trader_id
      WHERE e.rank <= $2`,
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
  rejects: number
  errors: number
}

export async function processTierB(job: Job<TierJobData>): Promise<TierBResult> {
  const src = await getSourceBySlug(job.data.sourceSlug)
  if (src.status !== 'active')
    return { tradersCrawled: 0, surfacesFetched: 0, rejects: 0, errors: 0 }

  const adapter = getAdapter(src.adapter_slug)
  if (!adapter.capabilities.profile) {
    return { tradersCrawled: 0, surfacesFetched: 0, rejects: 0, errors: 0 }
  }

  const topTraders = shuffle(await getTopTraders(src.id, src.deep_profile_topn))
  if (topTraders.length === 0) {
    console.log(`[tier-b] ${src.slug}: no passed snapshots yet — nothing to crawl`)
    return { tradersCrawled: 0, surfacesFetched: 0, rejects: 0, errors: 0 }
  }

  const timeframes = nativeRankingTimeframes(src)
  const session = await openSession(src)
  const result: TierBResult = { tradersCrawled: 0, surfacesFetched: 0, rejects: 0, errors: 0 }

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
            timeframe
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
      if (traderOk) result.tradersCrawled += 1
    }
  } finally {
    await session.close()
  }

  console.log(
    `[tier-b] ${src.slug}: ${result.tradersCrawled}/${topTraders.length} traders, ` +
      `${result.surfacesFetched} surfaces, ${result.rejects} rejects, ${result.errors} errors`
  )
  return result
}
