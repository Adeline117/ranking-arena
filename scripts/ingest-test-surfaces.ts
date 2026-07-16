/* eslint-disable no-console -- operator CLI intentionally prints crawl progress */
/**
 * One-off Phase-0 driver: exercise the Bitget profile/positions/history
 * surfaces end-to-end (fetch → RAW → parse → publish) for the top-N traders
 * of one source, without the queue. Usage:
 *   npx tsx scripts/ingest-test-surfaces.ts bitget_futures 2 [traderUid]
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config({ path: resolve(process.cwd(), 'worker', '.env') })
config({ path: resolve(process.cwd(), '.env.local') })

async function main() {
  const slug = process.argv[2] ?? 'bitget_futures'
  const limit = Number(process.argv[3] ?? 2)
  const onlyTrader = process.argv[4] ?? null

  await import('@/lib/ingest/adapters/register')
  const { getAdapter } = await import('@/lib/ingest/core/adapter')
  const { getSourceBySlug, nativeRankingTimeframes } = await import('@/lib/ingest/sources')
  const { openSession } = await import('@/lib/ingest/fetch/fetcher')
  const { writeRawObject } = await import('@/lib/ingest/raw')
  const { recordStagingRejects } = await import('@/lib/ingest/staging/rejects')
  const { validateStats } = await import('@/lib/ingest/staging/validate')
  const { publishProfile, publishPositions, publishHistoryRows, getHistoryCursor } =
    await import('@/lib/ingest/serving/publish')
  const { getIngestPool, closeIngestPool } = await import('@/lib/ingest/db')

  const src = await getSourceBySlug(slug)
  const adapter = getAdapter(src.adapter_slug)

  const { rows: targets } = await getIngestPool().query<{
    id: number
    exchange_trader_id: string
    meta: Record<string, unknown> | null
  }>(
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
      WHERE ($3::text IS NULL AND e.rank <= 10) OR t.exchange_trader_id = $3
      LIMIT $2`,
    [src.id, limit, onlyTrader]
  )
  console.log(`targets:`, targets)

  const session = await openSession(src)
  const ctxOf = () => ({
    sourceSlug: src.slug,
    currency: src.currency,
    tfLabelMap: src.tf_label_map,
    scrapedAt: new Date().toISOString(),
    meta: src.meta,
  })

  try {
    for (const trader of targets) {
      // profile ×3 TF
      for (const tf of nativeRankingTimeframes(src)) {
        const bundle = await adapter.getProfile(
          session,
          src,
          trader.exchange_trader_id,
          tf,
          trader.meta,
          { intent: 'scheduled_full' }
        )
        const rawObjectId = await writeRawObject({
          sourceId: src.id,
          sourceSlug: src.slug,
          jobType: 'tier_b',
          traderId: trader.id,
          timeframe: tf,
          payload: bundle.pages,
        })
        const ctx = ctxOf()
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
                    timeframe: tf,
                    scraped_at: ctx.scrapedAt,
                    page_count: 0,
                  },
                },
              ]
            : parsedPages.flatMap(({ page, profile }) =>
                (adapter.validateProfile?.(profile, ctx, tf, page.payload) ?? []).map((reject) => ({
                  reason: reject.reason,
                  payload: {
                    ...reject.payload,
                    source_slug: src.slug,
                    trader_id: trader.id,
                    exchange_trader_id: trader.exchange_trader_id,
                    timeframe: tf,
                    scraped_at: ctx.scrapedAt,
                    page_index: page.pageIndex,
                  },
                }))
              )
        if (qualityRejects.length > 0) {
          await recordStagingRejects(src.id, rawObjectId, qualityRejects)
          throw new Error(
            `[profile] ${trader.exchange_trader_id} ${tf}d quality rejected: ` +
              qualityRejects.map((reject) => reject.reason).join(',')
          )
        }
        for (const { profile } of parsedPages) {
          const { valid, rejects } = validateStats(profile.stats, [])
          await publishProfile(src, trader.id, { ...profile, stats: valid }, { fullSeries: true })
          console.log(
            `[profile] ${trader.exchange_trader_id} ${tf}d: stats=${valid.length} ` +
              `series=${profile.series.map((s) => `${s.metric}:${s.points.length}`).join(',')} ` +
              `rejects=${rejects.length}`
          )
        }
      }

      // positions (capability-gated, like Tier-D)
      if (adapter.capabilities.positions) {
        const posBundle = await adapter.getPositions(
          session,
          src,
          trader.exchange_trader_id,
          trader.meta
        )
        const positions = posBundle.pages.flatMap((p) => adapter.parsePositions(p.payload, ctxOf()))
        const delayH = Number(src.meta.positions_delay_hours ?? 0) || 0
        await publishPositions(
          src,
          trader.id,
          positions,
          new Date(Date.now() - delayH * 3_600_000).toISOString()
        )
        console.log(`[positions] ${trader.exchange_trader_id}: ${positions.length} open`)
      }

      // histories (capability-gated, like Tier-B)
      for (const kind of ['position_history', 'copiers'] as const) {
        if (kind === 'position_history' && !adapter.capabilities.positionHistory) continue
        if (kind === 'copiers' && !adapter.capabilities.copiers) continue
        const cursor = await getHistoryCursor(trader.id, kind)
        const rows: import('@/lib/ingest/core/types').ParsedHistoryRow[] = []
        let pages = 0
        for await (const page of adapter.getHistory(
          session,
          src,
          trader.exchange_trader_id,
          kind,
          cursor,
          trader.meta
        )) {
          pages += 1
          rows.push(...adapter.parseHistory(page.payload, kind, ctxOf()))
          if (pages >= 3) break // smoke test: cap at 3 pages
        }
        let newest: string | null = null
        for (const row of rows) {
          const ts = row.kind === 'position_history' ? row.closedAt : row.ts
          if (ts && (newest === null || ts > newest)) newest = ts
        }
        const written = await publishHistoryRows(src, trader.id, kind, rows, newest)
        console.log(
          `[${kind}] ${trader.exchange_trader_id}: pages=${pages} parsed=${rows.length} written=${written} cursor=${cursor} → ${newest}`
        )
      }
    }
  } finally {
    await session.close()
  }

  // verify serving rows landed
  const verify = await getIngestPool().query(
    `SELECT
       (SELECT count(*) FROM arena.trader_stats st JOIN arena.traders t ON t.id = st.trader_id
         WHERE t.source_id = $1 AND st.sharpe IS NULL AND st.mdd IS NOT NULL) AS deep_stats,
       (SELECT count(*) FROM arena.trader_series s JOIN arena.traders t ON t.id = s.trader_id
         WHERE t.source_id = $1) AS series_points,
       (SELECT count(*) FROM arena.positions_current p JOIN arena.traders t ON t.id = p.trader_id
         WHERE t.source_id = $1) AS positions,
       (SELECT count(*) FROM arena.position_history ph JOIN arena.traders t ON t.id = ph.trader_id
         WHERE t.source_id = $1) AS position_history,
       (SELECT count(*) FROM arena.copier_records cr JOIN arena.traders t ON t.id = cr.trader_id
         WHERE t.source_id = $1) AS copier_records`,
    [src.id]
  )
  console.log('serving rows:', verify.rows[0])

  await closeIngestPool()
  process.exit(0)
}
main().catch((err) => {
  console.error('FAILED:', err)
  process.exit(1)
})
