/**
 * Board-card extras projection (spec §2.4-1).
 *
 * The first screen renders ONLY what the leaderboard itself exposed — the
 * raw board row is stored verbatim in arena.leaderboard_entries.raw and
 * surfaced by the arena_first_screen RPC as entries[].extras. This module
 * projects that per-source raw shape into superset metric keys (matching
 * lib/constants/metric-registry.ts) so the hero strip reuses the same
 * registry-driven formatting as the core modules.
 *
 * Data-driven: one small declarative projection per source slug, generic
 * key-scan fallback for everything else. Adding an exchange means adding a
 * projection entry (or nothing, if the generic scan covers it) — never UI
 * code. The per-source maps can later migrate into arena.sources.meta
 * (board_fields) without changing consumers.
 */

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** UTA itemVoList → metric map: [{showColumnCode, comparedValue}, ...]. */
function utaColumns(raw: Dict): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  const cols = raw.itemVoList
  if (Array.isArray(cols)) {
    for (const col of cols as Dict[]) {
      const code = col.showColumnCode
      if (typeof code === 'string') out[code] = num(col.comparedValue)
    }
  }
  return out
}

/** Normalize a sparkline value: number[] or [{value|profit|y}, ...]. */
function sparklineOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null
  const points: number[] = []
  for (const p of v) {
    const n =
      typeof p === 'object' && p !== null
        ? num((p as Dict).value ?? (p as Dict).profit ?? (p as Dict).y)
        : num(p)
    if (n !== null) points.push(n)
  }
  return points.length > 0 ? points : null
}

/** Bitget family (futures/spot/cfd/bots): UTA columns + legacy keys. */
function bitgetProjection(raw: Dict): Dict {
  const cols = utaColumns(raw)
  return {
    win_rate: cols.winning_rate ?? num(raw.winRate),
    mdd: cols.max_retracement ?? num(raw.drawDown ?? raw.maxDrawdown),
    copier_pnl: cols.total_follow_profit ?? num(raw.copyTraderProfit ?? raw.traceProfit),
    aum: cols.total_follow_trade_amount ?? num(raw.totalFollowAssets),
    copier_count: num(raw.followCount ?? raw.copyTraderNum ?? raw.traceUserNum),
    sparkline: sparklineOf(raw.klineProfit),
  }
}

/** Generic fallback: scan the common key spellings seen across sources. */
function genericProjection(raw: Dict): Dict {
  return {
    win_rate: num(raw.winRate ?? raw.win_rate ?? raw.winningRate),
    mdd: num(raw.mdd ?? raw.maxDrawdown ?? raw.max_drawdown ?? raw.drawDown),
    copier_pnl: num(raw.copierPnl ?? raw.copyTraderProfit ?? raw.followerPnl),
    aum: num(raw.aum ?? raw.leadAum ?? raw.totalFollowAssets),
    copier_count: num(raw.copiers ?? raw.copierCount ?? raw.followCount ?? raw.copyTraderNum),
    sparkline: sparklineOf(raw.sparkline ?? raw.klineProfit ?? raw.pnlTrend),
  }
}

const PROJECTIONS: Record<string, (raw: Dict) => Dict> = {
  bitget_futures: bitgetProjection,
  bitget_spot: bitgetProjection,
  bitget_cfd: bitgetProjection,
  bitget_bots: bitgetProjection,
}

/**
 * Project a raw board row into superset-keyed extras. NULL/undefined values
 * are dropped (spec §6 NULL-collapse: absent ≠ zero), so consumers can
 * render `key in extras` cells without dash placeholders.
 */
export function projectBoardExtras(
  source: string,
  raw: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!raw || typeof raw !== 'object') return {}
  const project = PROJECTIONS[source] ?? genericProjection
  const projected = project(raw)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(projected)) {
    if (value !== null && value !== undefined) out[key] = value
  }
  return out
}
