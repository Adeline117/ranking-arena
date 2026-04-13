/**
 * Standalone snapshot validation for OpenClaw .mjs scripts.
 *
 * Mirrors the bounds from lib/pipeline/types.ts VALIDATION_BOUNDS
 * and the logic from lib/pipeline/validate-before-write.ts.
 *
 * This is a plain ESM module — no TypeScript, no imports from @/lib/.
 * Keep these bounds in sync with VALIDATION_BOUNDS in lib/pipeline/types.ts.
 */

// ═══════════════════════════════════════════════════════
// Validation Bounds (synced from lib/pipeline/types.ts)
// ═══════════════════════════════════════════════════════

const BOUNDS = {
  roi_pct:          { min: -10000, max: 10000 },
  pnl_usd:          { min: -10_000_000, max: 100_000_000 },
  pnl_usd_dex_whale:{ min: -10_000_000, max: 1_000_000_000 },
  win_rate_pct:     { min: 0, max: 100 },
  max_drawdown_pct: { min: 0, max: 100 },
  sharpe_ratio:     { min: -20, max: 20 },
  arena_score:      { min: 0, max: 100 },
}

// DEX platforms that get the higher PnL ceiling
const PNL_WHALE_EXEMPT_PLATFORMS = new Set([
  'hyperliquid', 'gmx', 'dydx', 'drift',
])

// ═══════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════

function toNum(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ═══════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════

/**
 * Validate a single row before writing to trader_snapshots_v2.
 *
 * Accepts the parsed trader object (the shape produced by parseTrader in
 * fetch-blofin.mjs and siblings). Field names map as follows:
 *   roi / roi_pct          → ROI percentage check
 *   pnl / pnl_usd          → PnL USD check
 *   win_rate                → Win rate percentage check
 *   max_drawdown            → Max drawdown percentage check
 *   sharpe_ratio            → Sharpe ratio check
 *   arena_score             → Arena score check
 *   source / platform       → Required identity field
 *   source_trader_id / trader_key → Required identity field
 *
 * Also checks the metrics sub-object (for rows already shaped for v2 upsert).
 *
 * @param {Record<string, any>} row
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateRow(row) {
  if (!row) return { valid: false, reason: 'row is null/undefined' }

  // Resolve identity fields
  const platform = row.source || row.platform || null
  const traderId = row.source_trader_id || row.trader_key || null

  if (!platform) return { valid: false, reason: 'missing platform/source' }
  if (!traderId) return { valid: false, reason: 'missing source_trader_id/trader_key' }

  // Metrics can live at top level or inside row.metrics (v2 shape)
  const m = row.metrics || row

  // ── ROI ──
  const roi = toNum(m.roi) ?? toNum(m.roi_pct)
  if (roi != null) {
    if (roi < BOUNDS.roi_pct.min || roi > BOUNDS.roi_pct.max) {
      return { valid: false, reason: `ROI ${roi}% outside [${BOUNDS.roi_pct.min}, ${BOUNDS.roi_pct.max}]` }
    }
  }

  // ── PnL ──
  const pnl = toNum(m.pnl) ?? toNum(m.pnl_usd)
  if (pnl != null) {
    const isWhaleExempt = PNL_WHALE_EXEMPT_PLATFORMS.has(String(platform))
    const pnlMax = isWhaleExempt ? BOUNDS.pnl_usd_dex_whale.max : BOUNDS.pnl_usd.max
    if (pnl < BOUNDS.pnl_usd.min || pnl > pnlMax) {
      return { valid: false, reason: `PnL $${pnl} outside [${BOUNDS.pnl_usd.min}, ${pnlMax}]` }
    }
  }

  // ── ROI ≈ PnL (field mapping error) ──
  if (roi != null && pnl != null && Math.abs(roi) > 1000 && Math.abs(pnl) > 1000) {
    if (Math.abs(roi - pnl) < 1) {
      return { valid: false, reason: `roi_pct equals pnl_usd (roi=${roi}, pnl=${pnl}) — likely field mapping error` }
    }
  }

  // ── Win Rate ──
  const wr = toNum(m.win_rate)
  if (wr != null) {
    if (wr < BOUNDS.win_rate_pct.min || wr > BOUNDS.win_rate_pct.max) {
      return { valid: false, reason: `win_rate ${wr}% outside [0, 100]` }
    }
  }

  // ── Max Drawdown ──
  const mdd = toNum(m.max_drawdown)
  if (mdd != null) {
    if (mdd < BOUNDS.max_drawdown_pct.min || mdd > BOUNDS.max_drawdown_pct.max) {
      return { valid: false, reason: `max_drawdown ${mdd}% outside [0, 100]` }
    }
  }

  // ── Sharpe Ratio ──
  const sharpe = toNum(m.sharpe_ratio)
  if (sharpe != null) {
    if (sharpe < BOUNDS.sharpe_ratio.min || sharpe > BOUNDS.sharpe_ratio.max) {
      return { valid: false, reason: `sharpe_ratio ${sharpe} outside [${BOUNDS.sharpe_ratio.min}, ${BOUNDS.sharpe_ratio.max}]` }
    }
  }

  // ── Arena Score ──
  const score = toNum(m.arena_score)
  if (score != null) {
    if (score < BOUNDS.arena_score.min || score > BOUNDS.arena_score.max) {
      return { valid: false, reason: `arena_score ${score} outside [0, 100]` }
    }
  }

  return { valid: true }
}
