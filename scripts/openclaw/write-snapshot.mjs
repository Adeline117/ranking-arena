/**
 * Shared snapshot writer for ALL external scripts (Mac Mini, VPS, cron).
 *
 * ROOT CAUSE FIX: BloFin Mac Mini script wrote to `metrics` JSONB column
 * instead of individual columns (roi_pct, win_rate, etc.), causing 100%
 * null metrics for 785 traders. This happened because each script had its
 * own hand-rolled DB write code that drifted from the main app.
 *
 * This module is the SINGLE source of truth for snapshot schema mapping.
 * All external scripts MUST use writeSnapshots() instead of hand-rolling SQL.
 *
 * Usage:
 *   import { writeSnapshots } from './write-snapshot.mjs'
 *   const result = await writeSnapshots(supabase, traders, { platform, window })
 */

/**
 * Build a trader_snapshots_v2 row from normalized trader data.
 * Maps field names to the ACTUAL database columns.
 *
 * @param {object} t - Normalized trader with roi, pnl, win_rate, etc.
 * @param {string} platform - Platform key (e.g., 'blofin', 'binance_futures')
 * @param {string} marketType - Market type (e.g., 'futures', 'spot')
 * @param {string} window - Time window ('7D', '30D', '90D')
 * @returns {object} Row ready for Supabase upsert
 */
export function buildSnapshotRow(t, platform, marketType, window) {
  const now = new Date().toISOString()
  return {
    // Identity columns
    platform,
    market_type: marketType,
    trader_key: t.source_trader_id || t.trader_key,
    window: t.season_id || window,
    as_of_ts: t.captured_at || now,

    // Metric columns (individual — NOT metrics JSONB)
    roi_pct: t.roi ?? null,
    pnl_usd: t.pnl ?? null,
    win_rate: t.win_rate ?? null,
    max_drawdown: t.max_drawdown ?? null,
    sharpe_ratio: t.sharpe_ratio ?? null,
    trades_count: t.trades_count ?? null,
    followers: t.followers ?? null,
    copiers: t.copiers ?? null,
    arena_score: t.arena_score ?? null,

    // Metadata
    quality_flags: { is_suspicious: false, suspicion_reasons: [], data_completeness: 0.8 },
    updated_at: now,
  }
}

/**
 * Write trader snapshots to trader_snapshots_v2.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object[]} traders - Normalized trader array
 * @param {{ platform: string, marketType?: string, window?: string }} opts
 * @returns {{ total: number, saved: number, error?: string }}
 */
export async function writeSnapshots(supabase, traders, opts) {
  const { platform, marketType = 'futures' } = opts

  if (!traders || traders.length === 0) {
    return { total: 0, saved: 0, error: 'No traders' }
  }

  const rows = traders
    .filter((t) => t.source_trader_id || t.trader_key)
    .map((t) => buildSnapshotRow(t, platform, marketType, opts.window || t.season_id || '90D'))

  if (rows.length === 0) {
    return { total: traders.length, saved: 0, error: 'No valid trader keys' }
  }

  const { error } = await supabase
    .from('trader_snapshots_v2')
    .upsert(rows, { onConflict: 'platform,market_type,trader_key,window,as_of_ts' })

  if (error && !error.message.includes('duplicate') && !error.message.includes('unique')) {
    console.error(`[write-snapshot] ${platform} v2 error:`, error.message)
    return { total: traders.length, saved: 0, error: error.message }
  }

  return { total: traders.length, saved: rows.length }
}
