/**
 * Compat dual-write into the legacy hot table (cutover plan step `shadow`).
 *
 * The entire legacy downstream — Arena Score → leaderboard_ranks → Redis
 * sorted sets → Meilisearch — hangs off public.trader_latest. While a
 * source is in shadow/serving mode, the new pipeline upserts the same rows
 * the old connector would have written, so the product keeps working with
 * ZERO changes downstream. Deleted at the endgame (score_inputs view).
 *
 * Field semantics mirror lib/pipeline/types.ts exactly:
 *   roi_pct       percent, clamped to ±10000 (legacy validation bound)
 *   win_rate      0-100
 *   max_drawdown  0-100 POSITIVE percent
 *   pnl_usd       USD (compat only writes USDT sources; USDx/USDC sources
 *                 must never be coerced — they get no compat write)
 *
 * WORKER-ONLY MODULE (direct PG).
 */

import { getIngestPool } from '../db'
import type { SourceRow } from '../core/types'

const WINDOW_BY_TF: Record<number, string> = { 7: '7D', 30: '30D', 90: '90D' }

const clamp = (v: number | null, min: number, max: number): number | null =>
  v === null ? null : Math.max(min, Math.min(max, v))

export interface CompatWriteResult {
  written: number
  skipped: string | null
}

/**
 * Upsert the latest PASSED snapshot of (source, timeframe) into
 * public.trader_latest under the legacy platform name.
 * sources.meta.legacy_platform overrides the slug; explicitly setting it
 * to null in meta disables compat writes for that source.
 */
export async function compatWriteTraderLatest(
  src: SourceRow,
  timeframe: 7 | 30 | 90
): Promise<CompatWriteResult> {
  if (src.serving_mode === 'legacy') return { written: 0, skipped: 'legacy mode' }
  if (src.currency !== 'USDT') {
    // Never silently treat USDx/USDC as USDT (spec §5.8).
    return { written: 0, skipped: `non-USDT currency ${src.currency}` }
  }
  const platform = Object.prototype.hasOwnProperty.call(src.meta, 'legacy_platform')
    ? (src.meta.legacy_platform as string | null)
    : src.slug
  if (!platform) return { written: 0, skipped: 'legacy_platform disabled' }

  const marketType = src.product_type === 'spot' ? 'spot' : 'futures'
  const window = WINDOW_BY_TF[timeframe]

  const { rows } = await getIngestPool().query<{
    exchange_trader_id: string
    roi: string | null
    pnl: string | null
    win_rate: string | null
    mdd: string | null
    copier_count: number | null
    total_positions: number | null
  }>(
    `WITH latest AS (
       SELECT id, scraped_at FROM arena.leaderboard_snapshots
        WHERE source_id = $1 AND timeframe = $2 AND count_check_passed
        ORDER BY scraped_at DESC LIMIT 1
     )
     SELECT t.exchange_trader_id,
            e.headline_roi AS roi, e.headline_pnl AS pnl,
            e.headline_win_rate AS win_rate,
            st.mdd, st.copier_count, st.total_positions
       FROM latest l
       JOIN arena.leaderboard_entries e
         ON e.snapshot_id = l.id AND e.scraped_at = l.scraped_at
       JOIN arena.traders t ON t.id = e.trader_id
       LEFT JOIN arena.trader_stats st
         ON st.trader_id = t.id AND st.timeframe = $2`,
    [src.id, timeframe]
  )
  if (rows.length === 0) return { written: 0, skipped: 'no passed snapshot' }

  const payload = rows.map((r) => ({
    trader_key: r.exchange_trader_id,
    roi_pct: clamp(r.roi === null ? null : Number(r.roi), -10_000, 10_000),
    pnl_usd: r.pnl === null ? null : Number(r.pnl),
    win_rate: clamp(r.win_rate === null ? null : Number(r.win_rate), 0, 100),
    max_drawdown: clamp(r.mdd === null ? null : Math.abs(Number(r.mdd)), 0, 100),
    copiers: r.copier_count,
    trades_count: r.total_positions,
  }))

  const result = await getIngestPool().query(
    `INSERT INTO public.trader_latest
       (platform, market_type, trader_key, "window", roi_pct, pnl_usd, win_rate,
        max_drawdown, copiers, trades_count, provenance, updated_at, fetched_at)
     SELECT $1, $2, r.trader_key, $3, r.roi_pct, r.pnl_usd, r.win_rate,
            r.max_drawdown, r.copiers, r.trades_count,
            jsonb_build_object('pipeline', 'arena_ingest_v2'), now(), now()
       FROM jsonb_to_recordset($4::jsonb) AS r(
         trader_key text, roi_pct numeric, pnl_usd numeric, win_rate numeric,
         max_drawdown numeric, copiers int, trades_count int)
     ON CONFLICT (platform, trader_key, "window") DO UPDATE SET
       market_type   = EXCLUDED.market_type,
       roi_pct       = EXCLUDED.roi_pct,
       pnl_usd       = EXCLUDED.pnl_usd,
       win_rate      = EXCLUDED.win_rate,
       max_drawdown  = EXCLUDED.max_drawdown,
       copiers       = EXCLUDED.copiers,
       trades_count  = EXCLUDED.trades_count,
       provenance    = EXCLUDED.provenance,
       updated_at    = now(),
       fetched_at    = now()`,
    [platform, marketType, window, JSON.stringify(payload)]
  )

  return { written: result.rowCount ?? 0, skipped: null }
}
