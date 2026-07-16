/**
 * GMX pure parsers (spec §7 #32).
 *
 * Inputs are the composite RAW payloads the adapter stores:
 *   leaderboard page: { timeframe, from, reportedTotal, rows } — rows are
 *     PeriodAccountStatObject dicts from the Squids subgraph, already
 *     sorted+truncated fetch-side (hyperliquid pattern)
 *   profile bundle:   { periodStats, pnlHistory, timeframe, from }
 *   positions:        { positions, markets, tokens } — markets/tokens are
 *     embedded so symbol/decimal resolution stays a pure re-parse (§5.5)
 *
 * Unit ground truth (verified live 2026-06-12 against the subgraph +
 * accountPnlSummaryStats cross-check):
 *   - ALL USD amounts are fixed-point 1e30 (GMX v2 convention)
 *   - realized-net window PnL = realizedPnl − realizedFees −
 *     realizedSwapFees + realizedPriceImpact + realizedSwapImpact
 *   - total window PnL (incl. unrealized) = last cumulativePnl of
 *     accountPnlHistoryStats; it is retained as audit metadata, never mixed
 *     into the canonical realized-net PnL or chart series
 *   - ROI basis = maxCapital (the official pnlBps denominator)
 *   - position entryPrice = raw / 10^(30 − indexTokenDecimals);
 *     leverage = raw / 1e4
 */

import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  RankingTimeframe,
} from '../../core/types'
type Dict = Record<string, unknown>

const E30 = 1e30
const DAY_SECONDS = 86_400

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 1e30 fixed-point string → USD number (null-safe). */
function usd(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n / E30
}

/** Arena Score caps at ±10000% internally; clamp like the legacy connector. */
function clampRoiPct(roi: number | null): number | null {
  if (roi === null) return null
  return Math.max(-10_000, Math.min(10_000, roi))
}

/**
 * Realized-net window PnL in USD (verified identity, see header). All five
 * components are required: treating a missing fee/impact as zero would make a
 * schema regression look like profit. Window-start unrealized fields do not
 * belong in realized PnL.
 */
export function gmxRealizedPnlUsd(row: Dict): number | null {
  const parts = [
    num(row.realizedPnl),
    num(row.realizedFees),
    num(row.realizedSwapFees),
    num(row.realizedPriceImpact),
    num(row.realizedSwapImpact),
  ]
  if (parts.some((part) => part === null)) return null
  const [pnl, fees, swapFees, priceImpact, swapImpact] = parts as number[]
  return (pnl - fees - swapFees + priceImpact + swapImpact) / E30
}

interface GmxWindowContract {
  timeframe: RankingTimeframe
  from: number
  to: number
}

function readGmxWindowContract(payload: {
  timeframe?: unknown
  from?: unknown
  to?: unknown
}): GmxWindowContract {
  const timeframe = num(payload.timeframe)
  if (timeframe !== 7 && timeframe !== 30 && timeframe !== 90) {
    throw new Error('[gmx] invalid window timeframe')
  }
  const from = num(payload.from)
  const to = num(payload.to)
  if (
    from === null ||
    to === null ||
    !Number.isInteger(from) ||
    !Number.isInteger(to) ||
    from <= 0 ||
    to <= from ||
    from % DAY_SECONDS !== 0 ||
    to % DAY_SECONDS !== 0 ||
    to - from !== timeframe * DAY_SECONDS
  ) {
    throw new Error('[gmx] invalid completed UTC window bounds')
  }
  return { timeframe, from, to }
}

function windowContractExtras(window: GmxWindowContract): Record<string, unknown> {
  return {
    window_from: window.from,
    window_to: window.to,
    window_duration_days: window.timeframe,
    window_semantics: 'completed_utc_days',
  }
}

function realizedPnlBasisExtras(
  realizedPnl: number,
  window: GmxWindowContract
): Record<string, unknown> {
  return {
    pnl_basis: 'gmx_period_realized_net',
    roi_basis: 'max_capital_usd',
    pnl_includes_unrealized: false,
    realized_pnl_usd: realizedPnl,
    pnl_components_complete: true,
    profile_series_contract: 'unavailable_same_basis',
    ...windowContractExtras(window),
  }
}

function winRatePct(row: Dict): number | null {
  const wins = num(row.wins) ?? 0
  const losses = num(row.losses) ?? 0
  const total = wins + losses
  return total > 0 ? (wins / total) * 100 : null
}

function roiOnMaxCapital(pnlUsd: number | null, row: Dict): number | null {
  const maxCapital = usd(row.maxCapital)
  if (pnlUsd === null || maxCapital === null || maxCapital <= 0) return null
  return clampRoiPct((pnlUsd / maxCapital) * 100)
}

// ── Leaderboard ──

export function parseGmxLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as {
    timeframe?: unknown
    reportedTotal?: unknown
    rows?: unknown
    from?: unknown
    to?: unknown
  }
  const items = Array.isArray(payload.rows) ? (payload.rows as Dict[]) : []
  const window = readGmxWindowContract(payload)

  const rows: ParsedLeaderboardRow[] = []
  for (const item of items) {
    const address = String(item.id ?? '')
      .trim()
      .toLowerCase()
    if (!address.startsWith('0x')) continue // no identity → cannot publish

    const pnl = gmxRealizedPnlUsd(item)
    if (pnl === null) {
      throw new Error('[gmx] incomplete realized-net leaderboard components')
    }
    rows.push({
      exchangeTraderId: address,
      rank: rows.length + 1, // chunk-local; tier-a re-anchors by page_size
      nickname: null, // on-chain — no names
      avatarUrlOrigin: null,
      walletAddress: address, // spec §1.4 on-chain identity
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: roiOnMaxCapital(pnl, item),
      headlinePnl: pnl,
      headlineWinRate: winRatePct(item),
      // maxCapital = the trader's peak capital (1e30 fixed-point → usd) = AUM basis;
      // the profile uses the same field. Board-level capture covers profile-less
      // traders. (On-chain: no precomputed MDD/Sharpe → those stay N/A.)
      headlineAum: usd(item.maxCapital),
      headlineExtras: realizedPnlBasisExtras(pnl, window),
      traderMeta: null,
      raw: item, // full PeriodAccountStatObject verbatim (spec §3)
    })
  }

  return { rows, reportedTotal: num(payload.reportedTotal) }
}

// ── Profile ──

interface HistPoint {
  timestamp?: unknown
  cumulativePnl?: unknown
}

/**
 * Profile = periodAccountStats (id_eq) + accountPnlHistoryStats, both for
 * the same window. Canonical trader_stats.pnl/roi use the same realized-net
 * basis as the board. The history endpoint is total mark-to-market and cannot
 * produce a same-basis canonical series, so it is retained only as explicit
 * audit metadata and any old generic `pnl` series is cleared.
 */
export function parseGmxProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const payload = (raw ?? {}) as {
    periodStats?: unknown
    pnlHistory?: unknown
    timeframe?: unknown
    from?: unknown
    to?: unknown
  }
  const window = readGmxWindowContract(payload)
  const tf = window.timeframe

  if (!Array.isArray(payload.periodStats) || !Array.isArray(payload.pnlHistory)) {
    throw new Error('[gmx] invalid profile bundle arrays')
  }

  const stats: ParsedProfile['stats'] = []
  const ps = payload.periodStats as Dict[]
  if (ps.length > 1) {
    throw new Error('[gmx] duplicate period aggregates for profile window')
  }
  const row = ps[0] ?? null

  const histRaw = payload.pnlHistory as HistPoint[]
  const points: Array<{ ts: number; value: number }> = []
  for (const p of histRaw) {
    const ts = num(p.timestamp)
    const value = usd(p.cumulativePnl)
    // accountPnlHistoryStats currently has no `to` argument. Keep the RAW
    // response intact, but only use points inside the exact period window for
    // audit metadata; canonical realized-net stats never use this MTM history.
    if (ts !== null && value !== null && ts >= window.from && ts <= window.to) {
      points.push({ ts: ts * 1000, value })
    }
  }
  points.sort((a, b) => a.ts - b.ts)

  const totalPnl = points.length > 0 ? points[points.length - 1].value : null

  if (row) {
    const realizedPnl = gmxRealizedPnlUsd(row)
    if (realizedPnl === null) {
      throw new Error('[gmx] incomplete realized-net profile components')
    }
    const aum = usd(row.maxCapital)
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: roiOnMaxCapital(realizedPnl, row),
      pnl: realizedPnl,
      sharpe: null,
      mdd: null,
      winRate: winRatePct(row),
      winPositions: num(row.wins),
      totalPositions: (num(row.wins) ?? 0) + (num(row.losses) ?? 0),
      copierPnl: null, // DEX — no copy trading
      copierCount: null,
      aum,
      volume: usd(row.volume),
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        ...realizedPnlBasisExtras(realizedPnl, window),
        aum_basis: 'max_capital_proxy', // legacy-connector convention
        gmx_total_mark_to_market_pnl_usd: totalPnl,
        gmx_total_mark_to_market_source: 'account_pnl_history_cumulative',
        gmx_history_client_window_cutoff: true,
        gmx_history_rows_raw: histRaw.length,
        gmx_history_rows_in_window: points.length,
        closed_count: num(row.closedCount),
      },
    })
  } else if (histRaw.length === 0) {
    // Both complete window queries agree that this account had no activity.
    // Publish an explicit zero so a rolling window that becomes inactive does
    // not keep stale PnL/trade counts forever. Missing capital means ROI stays
    // honestly null; the empty replacement below removes any old MTM series.
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: null,
      pnl: 0,
      sharpe: null,
      mdd: null,
      winRate: null,
      winPositions: 0,
      totalPositions: 0,
      copierPnl: null,
      copierCount: null,
      aum: null,
      volume: 0,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        ...realizedPnlBasisExtras(0, window),
        profile_window_metrics_complete: true,
        profile_window_empty: true,
        empty_window_evidence: 'explicit_empty_period_stats_and_history',
        aum_basis: 'max_capital_proxy',
        gmx_total_mark_to_market_pnl_usd: null,
        gmx_total_mark_to_market_source: 'account_pnl_history_cumulative',
        closed_count: 0,
      },
    })
  } else {
    // A non-empty history with no period aggregate is internally inconsistent.
    // Emit audit evidence marked incomplete: publishers preserve the last
    // proven typed values/series and processors surface a real crawl failure.
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: null,
      pnl: null,
      sharpe: null,
      mdd: null,
      winRate: null,
      winPositions: null,
      totalPositions: null,
      copierPnl: null,
      copierCount: null,
      aum: null,
      volume: null,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        profile_window_metrics_complete: false,
        profile_window_metrics_incomplete_reason: 'period_stats_missing_with_history',
        profile_series_contract: 'unavailable_same_basis',
        ...windowContractExtras(window),
        gmx_total_mark_to_market_pnl_usd: totalPnl,
        gmx_total_mark_to_market_source: 'account_pnl_history_cumulative',
        gmx_history_client_window_cutoff: true,
        gmx_history_rows_raw: histRaw.length,
        gmx_history_rows_in_window: points.length,
      },
    })
  }

  return {
    stats,
    series: [],
    replaceSeries: [{ timeframe: tf, metrics: ['pnl'] }],
    nickname: null,
    avatarUrlOrigin: null,
  }
}

// ── Positions ──

interface TokenInfo {
  symbol?: unknown
  address?: unknown
  decimals?: unknown
}

/**
 * { positions, markets, tokens } → open positions. markets maps market →
 * indexToken; tokens (gmxinfra REST) maps indexToken → symbol+decimals.
 * Unmappable markets fall back to the market address as symbol.
 */
export function parseGmxPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const payload = (raw ?? {}) as { positions?: unknown; markets?: unknown; tokens?: unknown }
  const positions = Array.isArray(payload.positions) ? (payload.positions as Dict[]) : []
  const markets = Array.isArray(payload.markets) ? (payload.markets as Dict[]) : []
  const tokens = Array.isArray(payload.tokens) ? (payload.tokens as TokenInfo[]) : []

  const indexTokenByMarket = new Map<string, string>()
  for (const m of markets) {
    if (typeof m.id === 'string' && typeof m.indexToken === 'string') {
      indexTokenByMarket.set(m.id.toLowerCase(), m.indexToken.toLowerCase())
    }
  }
  const tokenByAddress = new Map<string, { symbol: string; decimals: number }>()
  for (const t of tokens) {
    if (typeof t.address === 'string' && typeof t.symbol === 'string') {
      tokenByAddress.set(t.address.toLowerCase(), {
        symbol: t.symbol,
        decimals: num(t.decimals) ?? 18,
      })
    }
  }

  const out: ParsedPosition[] = []
  for (const pos of positions) {
    if (pos.isSnapshot === true) continue // belt-and-braces (fetch filters too)
    const marketAddr = typeof pos.market === 'string' ? pos.market.toLowerCase() : null
    const indexToken = marketAddr ? (indexTokenByMarket.get(marketAddr) ?? null) : null
    const token = indexToken ? (tokenByAddress.get(indexToken) ?? null) : null

    const sizeUsd = usd(pos.sizeInUsd)
    if (sizeUsd === null || sizeUsd === 0) continue

    const decimals = token?.decimals ?? 18
    const sizeTokens = num(pos.sizeInTokens)
    const size = sizeTokens === null ? null : sizeTokens / 10 ** decimals
    const entryRaw = num(pos.entryPrice)
    const leverageRaw = num(pos.leverage)

    out.push({
      symbol: token?.symbol ?? (typeof pos.market === 'string' ? pos.market : 'UNKNOWN'),
      side: pos.isLong === true ? 'long' : pos.isLong === false ? 'short' : null,
      leverage: leverageRaw === null ? null : leverageRaw / 1e4,
      size,
      entryPrice: entryRaw === null ? null : entryRaw / 10 ** (30 - decimals),
      markPrice: null, // subgraph has no live mark price
      unrealizedPnl: usd(pos.unrealizedPnl),
      raw: pos,
    })
  }
  return out
}

// ── Histories ──

/** No append-only history surfaces in v1 (capabilities all false). */
export function parseGmxHistory(
  _raw: unknown,
  kind: HistoryKind,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  throw new Error(`[gmx] history surface ${kind} not supported`)
}
