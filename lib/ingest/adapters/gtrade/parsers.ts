/**
 * gTrade (Gains Network) pure parsers (spec §7 #34, §11.20).
 *
 * Inputs are the composite RAW payloads the adapter stores:
 *   leaderboard page: { timeframe, rows, reportedTotal } — rows are the TF
 *     key ("7"/"30"/"90") of backend-global /api/leaderboard/all
 *   profile bundle:   { stats, timeframe, tradesSnapshot } — lifetime stats
 *     + replayable trades-table pages (newest→oldest), from which ALL per-TF
 *     aggregation is computed after proving that window complete
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
import { createHash } from 'crypto'
import { replayGtradeTradesSnapshot } from './trades-fetch'

function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

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
  if (pnlNet === null) throw new Error('[gtrade] history row has an invalid pnl_net')
  if (pnlNet === 0) return 0
  const px = num(row.collateralPriceUsd)
  if (px === null || px <= 0) {
    throw new Error('[gtrade] history realized PnL is missing collateralPriceUsd')
  }
  return pnlNet * px
}

function positionKey(row: TradeRow): string | null {
  const pair = typeof row.pair === 'string' ? row.pair : null
  const tradeIndex = num((row as Dict).tradeIndex)
  return pair === null || tradeIndex === null ? null : `${pair}#${tradeIndex}`
}

function isTerminalClose(action: unknown): boolean {
  return action === 'TradeClosedMarket' || action === 'TradeClosedLIQ'
}

/** Closed positions newer than cursor whose opening event is not in the rows. */
export function unmatchedGtradeCloseKeys(rows: unknown[], cursor: string | null): string[] {
  const cursorMs = cursor === null ? Number.NEGATIVE_INFINITY : Date.parse(cursor)
  if (cursor !== null && !Number.isFinite(cursorMs)) {
    throw new Error('[gtrade] invalid position history cursor')
  }
  const opened = new Set<string>()
  const closed = new Set<string>()
  for (const candidate of rows) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const row = candidate as TradeRow
    const key = positionKey(row)
    if (row.action === 'TradeOpenedMarket' && key !== null) opened.add(key)
    if (!isTerminalClose(row.action)) continue
    const closedAt = typeof row.date === 'string' ? Date.parse(row.date) : Number.NaN
    if (!Number.isFinite(closedAt) || key === null) {
      closed.add('[invalid-close]')
    } else if (closedAt > cursorMs) {
      closed.add(key)
    }
  }
  return [...closed].filter((key) => !opened.has(key)).sort()
}

/**
 * Profile = lifetime stats endpoint + window aggregation over the trades
 * table (the verified board semantics, see header). Daily-bucketed
 * cumulative PnL series comes from the same rows.
 */
export function parseGtradeProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const payload = (raw ?? {}) as {
    stats?: unknown
    trades?: unknown
    tradesSnapshot?: unknown
    tradesFetchState?: unknown
    tradesFetchReason?: unknown
    timeframe?: unknown
  }
  const tfNum = num(payload.timeframe) ?? 30
  const normalizedTf = tfNum === 0 ? 90 : tfNum
  if (normalizedTf !== 7 && normalizedTf !== 30 && normalizedTf !== 90) {
    throw new Error('[gtrade] invalid profile timeframe')
  }
  const tf = normalizedTf as RankingTimeframe
  const lifetime = (payload.stats ?? null) as Dict | null
  const replay = replayGtradeTradesSnapshot(payload.tradesSnapshot)
  const hasSnapshot = payload.tradesSnapshot !== undefined && payload.tradesSnapshot !== null
  const asOfTimeMs = replay.asOfTimeMs
  const asOf = asOfTimeMs === null ? ctx.scrapedAt : new Date(asOfTimeMs).toISOString()
  const windowStart = asOfTimeMs === null ? null : asOfTimeMs - tf * DAY_MS
  const windowCovered =
    windowStart !== null &&
    (replay.exhausted || (replay.oldestTimeMs !== null && replay.oldestTimeMs < windowStart))

  let metricsComplete = windowCovered
  let incompleteReason: string | null = null
  if (!hasSnapshot) {
    incompleteReason = payload.trades !== undefined ? 'legacy_unverified' : 'missing_snapshot'
    metricsComplete = false
  } else if (replay.stopReason === 'invalid_snapshot') {
    incompleteReason = 'invalid_snapshot'
    metricsComplete = false
  } else if (!windowCovered) {
    incompleteReason = 'window_prefix_not_covered'
    metricsComplete = false
  }

  let pnl = 0
  let wins = 0
  let closes = 0
  const daily = new Map<string, number>()
  if (metricsComplete && windowStart !== null) {
    for (const row of replay.trades as TradeRow[]) {
      const ts = typeof row.date === 'string' ? Date.parse(row.date) : NaN
      if (!Number.isFinite(ts) || ts < windowStart) continue
      const pnlNet = num(row.pnl_net)
      if (pnlNet === null) {
        metricsComplete = false
        incompleteReason = 'invalid_pnl_net'
        break
      }
      if (pnlNet === 0) continue
      const collateralPriceUsd = num(row.collateralPriceUsd)
      if (collateralPriceUsd === null || collateralPriceUsd <= 0) {
        metricsComplete = false
        incompleteReason = 'missing_collateral_price_usd'
        break
      }
      const usd = pnlNet * collateralPriceUsd
      pnl += usd
      closes += 1
      if (usd > 0) wins += 1
      const day = new Date(ts).toISOString().slice(0, 10)
      daily.set(day, (daily.get(day) ?? 0) + usd)
    }
  }

  // Daily-bucketed cumulative realized-PnL curve (shared by the series block
  // and Tier-0 risk derivation below).
  const cumPoints: Array<{ ts: string; value: number }> = []
  if (metricsComplete) {
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
  const ratios = metricsComplete
    ? ratiosFromCumulativePnl(cumPoints)
    : { sharpe: null, sortino: null, samples: 0 }
  const riskExtras: Record<string, unknown> =
    ratios.sharpe !== null || ratios.sortino !== null
      ? { risk_derivation: 'daily-approx', risk_samples: ratios.samples, sortino: ratios.sortino }
      : {}

  const stats: ParsedProfile['stats'] = [
    {
      timeframe: tf,
      asOf,
      roi: null, // no capital basis exposed → NULL
      pnl: metricsComplete ? pnl : null,
      sharpe: metricsComplete ? ratios.sharpe : null,
      mdd: null, // needs a real equity base gTrade doesn't expose → honest NULL
      winRate: metricsComplete && closes > 0 ? (wins / closes) * 100 : null,
      winPositions: metricsComplete ? wins : null,
      totalPositions: metricsComplete ? closes : null,
      copierPnl: null, // DEX — no copy trading
      copierCount: null,
      aum: null,
      volume: null, // per-TF volume not derivable honestly; lifetime in extras
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        profile_window_metrics_complete: metricsComplete,
        profile_window_metrics_incomplete_reason: metricsComplete ? null : incompleteReason,
        gtrade_trades_incomplete_reason: metricsComplete ? null : incompleteReason,
        gtrade_trades_fetch_state:
          typeof payload.tradesFetchState === 'string' ? payload.tradesFetchState : null,
        gtrade_trades_fetch_reason:
          typeof payload.tradesFetchReason === 'string' ? payload.tradesFetchReason : null,
        gtrade_trades_replay_stop_reason: replay.stopReason,
        gtrade_trades_valid_pages: replay.validPageCount,
        gtrade_trades_raw_pages: replay.rawPageCount,
        gtrade_trades_duplicate_rows: replay.duplicateRowCount,
        gtrade_trades_exhausted: replay.exhausted,
        gtrade_trades_window_start:
          windowStart === null ? null : new Date(windowStart).toISOString(),
        gtrade_trades_oldest_event:
          replay.oldestTimeMs === null ? null : new Date(replay.oldestTimeMs).toISOString(),
        ...(metricsComplete ? { pnl_basis: 'sum_pnl_net_usd', ...riskExtras } : {}),
        lifetime_volume: lifetime ? num(lifetime.totalVolume) : null,
        lifetime_trades: lifetime ? num(lifetime.totalTrades) : null,
        lifetime_win_rate: lifetime ? num(lifetime.winRate) : null,
        thirty_day_volume: lifetime ? num(lifetime.thirtyDayVolume) : null,
      },
    },
  ]

  const series: ParsedProfile['series'] = []
  if (metricsComplete && cumPoints.length > 0) {
    series.push({
      timeframe: tf,
      metric: 'pnl', // window-cumulative realized PnL, daily buckets
      points: cumPoints,
    })
  }

  return {
    stats,
    series,
    replaceSeries: [{ timeframe: tf, metrics: ['pnl'] }],
    nickname: null,
    avatarUrlOrigin: null,
  }
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
  if (kind !== 'orders' && kind !== 'position_history') {
    throw new Error(`[gtrade] history surface ${kind} not supported`)
  }
  const payload = (raw ?? {}) as { data?: unknown; tradesSnapshot?: unknown }
  const rows = Array.isArray(payload.data)
    ? (payload.data as TradeRow[])
    : (replayGtradeTradesSnapshot(payload.tradesSnapshot).trades as TradeRow[])
  if (kind === 'position_history') return gtradePositionHistory(rows)

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

/**
 * M3-3b (DEX Tier-1, 链上重组): rebuild closed positions from the flat trades
 * table. Actions carrying the same `pair + tradeIndex` belong to ONE position
 * (verified on the live fixture: open/increase/decrease/close all share it).
 * A row is emitted only for COMPLETE pairs — a TradeOpenedMarket AND a
 * TradeClosedMarket both inside the fetched window — so entry/exit are honest,
 * never guessed. Realized PnL sums every realizing action in the group
 * (partial decreases realize too — the same identity the board reconciles on).
 */
function gtradePositionHistory(rows: TradeRow[]): ParsedHistoryRow[] {
  type G = { open?: TradeRow; close?: TradeRow; realized: number; all: TradeRow[] }
  const groups = new Map<string, G>()
  for (const row of rows) {
    const key = positionKey(row)
    if (key === null) continue
    let g = groups.get(key)
    if (!g) {
      g = { realized: 0, all: [] }
      groups.set(key, g)
    }
    g.all.push(row)
    g.realized += realizedUsd(row)
    if (row.action === 'TradeOpenedMarket') g.open = row
    if (isTerminalClose(row.action)) g.close = row
  }

  const out: ParsedHistoryRow[] = []
  for (const [key, g] of groups) {
    if (!g.open || !g.close) continue // incomplete pair — open outside the window
    const openedAt = typeof g.open.date === 'string' ? g.open.date : null
    const closedAt = typeof g.close.date === 'string' ? g.close.date : null
    if (openedAt === null || closedAt === null) continue
    const addr = typeof (g.open as Dict).address === 'string' ? (g.open as Dict).address : ''
    out.push({
      kind: 'position_history',
      openedAt,
      closedAt,
      symbol: key.split('#')[0],
      side: g.open.long === 1 || g.open.long === true ? 'long' : 'short',
      leverage: num(g.open.leverage),
      size: num(g.open.size),
      entryPrice: num(g.open.price),
      exitPrice: num(g.close.price),
      realizedPnl: Math.round(g.realized * 1e6) / 1e6,
      dedupeHash: dedupeHash('gtrade_ph', addr, key, g.close.id),
      raw: { open: g.open, close: g.close, actions: g.all.length },
    })
  }
  return out
}
