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
import type { ParseCtx, ParsedLeaderboardRow, RawPage } from '@/lib/ingest/core/types'
import { openSession } from '@/lib/ingest/fetch/fetcher'
import { writeRawObject } from '@/lib/ingest/raw'
import { validateLeaderboardRows } from '@/lib/ingest/staging/validate'
import { publishLeaderboardSnapshot } from '@/lib/ingest/serving/publish'
import type { TierJobData } from '../queues'

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
  const session = await openSession(src)
  const results: TierAResult[] = []

  try {
    for (const timeframe of nativeRankingTimeframes(src)) {
      const scrapedAt = new Date().toISOString()
      const pages: RawPage[] = []
      for await (const page of adapter.listLeaderboard(session, src, timeframe)) {
        pages.push(page)
      }

      // RAW first — any downstream bug becomes a re-parse (spec §5.5).
      const rawObjectId = await writeRawObject({
        sourceId: src.id,
        sourceSlug: src.slug,
        jobType: 'tier_a',
        timeframe,
        payload: pages,
        meta: { pageCount: pages.length },
      })

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
      for (const page of pages) {
        const parsed = adapter.parseLeaderboard(page.payload, ctx)
        for (const row of parsed.rows) {
          rows.push({ ...row, rank: (page.pageIndex - 1) * pageSize + row.rank })
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
      })

      const status = result.published ? 'PUBLISHED' : 'GATED'
      console.log(
        `[tier-a] ${src.slug} ${timeframe}d: ${valid.length} rows ` +
          `(${rejects.length} rejected, baseline=${result.verdict.baselineUsed}, ` +
          `deviation=${result.verdict.deviationPct?.toFixed(1) ?? '–'}%) → ${status}`
      )
      if (!result.published) {
        // Alerting discipline (spec §15): real-time page only for phase<=1
        // Tier-A failures — wired through alerting.ts in its own commit;
        // the thrown error already fails the BullMQ job for retry+visibility.
        throw new Error(
          `[tier-a] count check FAILED for ${src.slug} ${timeframe}d: ` +
            `actual=${valid.length} baseline=${result.verdict.baselineUsed} — ` +
            `snapshot ${result.snapshotId} recorded, serving keeps last good`
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

      // Cutover shadow/serving: keep the legacy downstream chain alive
      // (Arena Score → leaderboard_ranks → Redis → Meilisearch).
      if (src.serving_mode !== 'legacy') {
        const { compatWriteTraderLatest } =
          await import('@/lib/ingest/serving/compat-trader-latest')
        const compat = await compatWriteTraderLatest(src, timeframe)
        console.log(
          `[tier-a] ${src.slug} ${timeframe}d compat→trader_latest: ` +
            (compat.skipped ?? `${compat.written} rows`)
        )
      }

      results.push({
        timeframe,
        actualCount: valid.length,
        rejects: rejects.length,
        passed: result.verdict.passed,
        baselineUsed: result.verdict.baselineUsed,
        snapshotId: result.snapshotId,
      })
    }
  } finally {
    await session.close()
  }

  return results
}
