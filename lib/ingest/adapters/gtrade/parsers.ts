/**
 * gTrade (Gains Network) pure parsers (spec §7 #34, §11.20).
 *
 * Inputs are the composite RAW payloads the adapter stores:
 *   leaderboard page: { timeframe, rows, reportedTotal } — rows are the TF
 *     key ("7"/"30"/"90") of backend-global /api/leaderboard/all
 *   profile bundle:   { stats, trades, timeframe } — lifetime stats endpoint
 *     + the trades table pages (newest→oldest), from which ALL per-TF
 *     aggregation is computed by us (spec §11.20)
 *   history (orders): one trades-table page verbatim
 *
 * Unit ground truth (verified live 2026-06-12):
 *   - board total_pnl = Σ pnl_net of realized rows in window EXACTLY;
 *     count = realized-row count; count_win = pnl_net > 0 rows
 *   - realized rows are those with pnl_net ≠ 0 (TradeClosedMarket,
 *     TradeClosedLIQ, partial TradePosSizeDecrease)
 *   - pnl_net is in COLLATERAL units → × collateralPriceUsd for USD
 *     (board total_pnl_usd applies the same conversion)
 *   - no capital basis exposed anywhere → ROI is NULL (spec §3 NULL
 *     semantics; board shows PnL only)
 */

import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedOrderRow,
  ParsedPosition,
  ParsedProfile,
  RankingTimeframe,
} from '../../core/types'
import { ratiosFromCumulativePnl } from '../../core/series-risk'

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function winRatePct(row: Dict): number | null {
  const wins = num(row.count_win)
  const total = num(row.count)
  if (wins === null || total === null || total <= 0) return null
  return Math.min((wins / total) * 100, 100)
}

// ── Leaderboard ──

export function parseGtradeLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as { rows?: unknown; reportedTotal?: unknown }
  const items = Array.isArray(payload.rows) ? (payload.rows as Dict[]) : []

  const rows: ParsedLeaderboardRow[] = []
  for (const item of items) {
    const address = String(item.address ?? '')
      .trim()
      .toLowerCase()
    if (!address.startsWith('0x')) continue // no identity → cannot publish

    rows.push({
      exchangeTraderId: address,
      rank: rows.length + 1, // chunk-local; tier-a re-anchors by page_size
      nickname: null, // on-chain — no names on the board (spec §11.20)
      avatarUrlOrigin: null,
      walletAddress: address, // spec §1.4 on-chain identity
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: null, // no capital basis exposed → NULL collapses in UI
      headlinePnl: num(item.total_pnl_usd) ?? num(item.total_pnl),
      headlineWinRate: winRatePct(item),
      traderMeta: null,
      raw: item, // count/avg_win/avg_loss/total_pnl verbatim (spec §3)
    })
  }

  return { rows, reportedTotal: num(payload.reportedTotal) }
}

// ── Profile (aggregated from the trades table, spec §11.20) ──

interface TradeRow extends Dict {
  date?: unknown
  pnl_net?: unknown
  collateralPriceUsd?: unknown
}

const DAY_MS = 86_400_000

/** A trade row's realized USD PnL (0 for non-realizing actions). */
function realizedUsd(row: TradeRow): number {
  const pnlNet = num(row.pnl_net)
  if (pnlNet === null || pnlNet === 0) return 0
  const px = num(row.collateralPriceUsd) ?? 1
  return pnlNet * px
}

/**
 * Profile = lifetime stats endpoint + window aggregation over the trades
 * table (the verified board semantics, see header). Daily-bucketed
 * cumulative PnL series comes from the same rows.
 */
export function parseGtradeProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const payload = (raw ?? {}) as { stats?: unknown; trades?: unknown; timeframe?: unknown }
  const tfNum = num(payload.timeframe) ?? 30
  const tf = (tfNum === 0 ? 90 : tfNum) as RankingTimeframe
  const lifetime = (payload.stats ?? null) as Dict | null
  const tradesWrap = (payload.trades ?? {}) as { data?: unknown; truncated?: unknown }
  const trades = Array.isArray(tradesWrap.data) ? (tradesWrap.data as TradeRow[]) : []

  const windowStart = Date.parse(ctx.scrapedAt) - tf * DAY_MS

  let pnl = 0
  let wins = 0
  let closes = 0
  let sawAny = false
  const daily = new Map<string, number>()
  for (const row of trades) {
    const ts = typeof row.date === 'string' ? Date.parse(row.date) : NaN
    if (!Number.isFinite(ts) || ts < windowStart) continue
    sawAny = true
    const usd = realizedUsd(row)
    if (usd === 0 && num(row.pnl_net) === 0) continue // non-realizing action
    pnl += usd
    closes += 1
    if (usd > 0) wins += 1
    const day = new Date(ts).toISOString().slice(0, 10)
    daily.set(day, (daily.get(day) ?? 0) + usd)
  }

  // Daily-bucketed cumulative realized-PnL curve (shared by the series block
  // and Tier-0 risk derivation below).
  const cumPoints: Array<{ ts: string; value: number }> = []
  {
    const days = [...daily.entries()].sort(([a], [b]) => a.localeCompare(b))
    let cum = 0
    for (const [day, value] of days) {
      cum += value
      cumPoints.push({ ts: `${day}T00:00:00.000Z`, value: cum })
    }
  }

  // Tier-0 base-free risk: gTrade exposes NO capital base (ROI/AUM are NULL), so
  // a percentage MDD isn't honestly derivable — but Sharpe/Sortino are, because
  // the constant-capital base cancels out of mean/std (see series-risk.ts). MDD
  // stays NULL. daily-approx provenance.
  const ratios = ratiosFromCumulativePnl(cumPoints)
  const riskExtras: Record<string, unknown> =
    ratios.sharpe !== null || ratios.sortino !== null
      ? { risk_derivation: 'daily-approx', risk_samples: ratios.samples, sortino: ratios.sortino }
      : {}

  const stats: ParsedProfile['stats'] = []
  if (sawAny || lifetime) {
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: null, // no capital basis exposed → NULL
      pnl: sawAny || closes > 0 ? pnl : null,
      sharpe: ratios.sharpe, // Tier-0 base-free daily-approx (base cancels)
      mdd: null, // needs a real equity base gTrade doesn't expose → honest NULL
      winRate: closes > 0 ? (wins / closes) * 100 : null,
      winPositions: closes > 0 ? wins : null,
      totalPositions: closes > 0 ? closes : null,
      copierPnl: null, // DEX — no copy trading
      copierCount: null,
      aum: null,
      volume: null, // per-TF volume not derivable honestly; lifetime in extras
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        pnl_basis: 'sum_pnl_net_usd', // verified board identity
        lifetime_volume: lifetime ? num(lifetime.totalVolume) : null,
        lifetime_trades: lifetime ? num(lifetime.totalTrades) : null,
        lifetime_win_rate: lifetime ? num(lifetime.winRate) : null,
        thirty_day_volume: lifetime ? num(lifetime.thirtyDayVolume) : null,
        // pages capped before reaching the window start → under-coverage
        trades_truncated: tradesWrap.truncated === true,
        ...riskExtras,
      },
    })
  }

  const series: ParsedProfile['series'] = []
  if (cumPoints.length > 0) {
    series.push({
      timeframe: tf,
      metric: 'pnl', // window-cumulative realized PnL, daily buckets
      points: cumPoints,
    })
  }

  return { stats, series, nickname: null, avatarUrlOrigin: null }
}

// ── Positions ──

/** Open positions need trading-variables pair-index mapping + 1e10/1e18
 *  on-chain scaling — deliberately out of v1 (capabilities.positions=false;
 *  spec §11.20 only lists the trades table). */
export function parseGtradePositions(_raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  throw new Error('[gtrade] positions surface not supported')
}

// ── Histories (orders = the trades table) ──

/**
 * One trades-table page → order records. dedupeHash = the source's own
 * monotonic row id (also the pagination cursor).
 */
export function parseGtradeHistory(
  raw: unknown,
  kind: HistoryKind,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  if (kind !== 'orders') throw new Error(`[gtrade] history surface ${kind} not supported`)
  const payload = (raw ?? {}) as { data?: unknown }
  const rows = Array.isArray(payload.data) ? (payload.data as TradeRow[]) : []

  const out: ParsedOrderRow[] = []
  for (const row of rows) {
    const ts = typeof row.date === 'string' ? row.date : null
    const id = num(row.id)
    if (ts === null || id === null) continue
    out.push({
      kind: 'orders',
      ts,
      orderKind: typeof row.action === 'string' ? row.action : null,
      symbol: typeof row.pair === 'string' ? row.pair : null,
      side: row.long === 1 || row.long === true ? 'long' : 'short',
      price: num(row.price),
      qty: num(row.size),
      dedupeHash: String(id),
      raw: row,
    })
  }
  return out
}
