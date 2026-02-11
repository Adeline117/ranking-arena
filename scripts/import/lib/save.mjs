/**
 * Shared save/upsert functions for trader data
 */
import { sb } from './supabase.mjs'
import { cs } from './scoring.mjs'

/**
 * Save traders to Supabase (trader_sources + trader_snapshots)
 * @param {string} source - Platform source identifier
 * @param {Array} traders - Array of { id, name, avatar, roi, pnl, wr, dd, trades }
 * @param {object} [opts] - Options
 * @param {string} [opts.seasonId='30D'] - Season ID
 * @param {string} [opts.marketType='futures'] - Market type
 * @returns {Promise<number>} Number of snapshots saved
 */
export async function save(source, traders, opts = {}) {
  const { seasonId = '30D', marketType = 'futures' } = opts
  if (!traders.length) return 0

  const now = new Date().toISOString()

  // Upsert trader_sources in batches of 50
  for (let i = 0; i < traders.length; i += 50) {
    try {
      await sb.from('trader_sources').upsert(
        traders.slice(i, i + 50).map(t => ({
          source,
          source_trader_id: t.id,
          handle: t.name || t.id,
          avatar_url: t.avatar || null,
          market_type: marketType,
          is_active: true
        })),
        { onConflict: 'source,source_trader_id' }
      )
    } catch {}
  }

  // Upsert trader_snapshots in batches of 30
  let saved = 0
  for (let i = 0; i < traders.length; i += 30) {
    const { error } = await sb.from('trader_snapshots').upsert(
      traders.slice(i, i + 30).map((t, j) => ({
        source,
        source_trader_id: t.id,
        season_id: seasonId,
        rank: i + j + 1,
        roi: t.roi,
        pnl: t.pnl,
        win_rate: t.wr,
        max_drawdown: t.dd,
        trades_count: t.trades,
        arena_score: cs(t.roi, t.pnl, t.dd, t.wr),
        captured_at: now
      })),
      { onConflict: 'source,source_trader_id,season_id' }
    )
    if (!error) saved += Math.min(30, traders.length - i)
  }
  return saved
}
