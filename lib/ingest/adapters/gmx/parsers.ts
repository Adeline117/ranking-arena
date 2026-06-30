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
 *   - realized-basis window PnL = realizedPnl − realizedFees +
 *     realizedPriceImpact − startUnrealizedPnl + startUnrealizedFees
 *     (matches summary realizedPnlUsd exactly)
 *   - total window PnL (incl. unrealized) = last cumulativePnl of
 *     accountPnlHistoryStats (matches summary pnlUsd exactly)
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
import { riskFromCumulativePnl } from '../../core/series-risk'

type Dict = Record<string, unknown>

const E30 = 1e30

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
 * Realized-basis window PnL in USD (verified identity, see header).
 * The board can't see CURRENT unrealized PnL (that would need live mark
 * prices per position), so board ranks/headlines use the realized basis.
 */
export function gmxRealizedPnlUsd(row: Dict): number | null {
  const parts = [
    num(row.realizedPnl),
    num(row.realizedFees),
    num(row.realizedPriceImpact),
    num(row.startUnrealizedPnl),
    num(row.startUnrealizedFees),
  ]
  if (parts[0] === null) return null
  const [pnl, fees, impact, startUpnl, startUfees] = parts.map((p) => p ?? 0)
  return (pnl - fees + impact - startUpnl + startUfees) / E30
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
  const payload = (raw ?? {}) as { reportedTotal?: unknown; rows?: unknown }
  const items = Array.isArray(payload.rows) ? (payload.rows as Dict[]) : []

  const rows: ParsedLeaderboardRow[] = []
  for (const item of items) {
    const address = String(item.id ?? '')
      .trim()
      .toLowerCase()
    if (!address.startsWith('0x')) continue // no identity → cannot publish

    const pnl = gmxRealizedPnlUsd(item)
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
 * the same window. trader_stats.pnl/roi use the TOTAL basis (incl.
 * unrealized — what the GMX UI shows); the realized basis the board ranks
 * by is disclosed in extras.
 */
export function parseGmxProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const payload = (raw ?? {}) as {
    periodStats?: unknown
    pnlHistory?: unknown
    timeframe?: unknown
    from?: unknown
  }
  const tfNum = num(payload.timeframe) ?? 30
  const tf = (tfNum === 0 ? 90 : tfNum) as RankingTimeframe

  const stats: ParsedProfile['stats'] = []
  const series: ParsedProfile['series'] = []

  const ps = Array.isArray(payload.periodStats) ? (payload.periodStats as Dict[]) : []
  const row = ps[0] ?? null

  const histRaw = Array.isArray(payload.pnlHistory) ? (payload.pnlHistory as HistPoint[]) : []
  const points: Array<{ ts: number; value: number }> = []
  for (const p of histRaw) {
    const ts = num(p.timestamp)
    const value = usd(p.cumulativePnl)
    if (ts !== null && value !== null) points.push({ ts: ts * 1000, value })
  }
  points.sort((a, b) => a.ts - b.ts)

  const totalPnl = points.length > 0 ? points[points.length - 1].value : null

  if (row || totalPnl !== null) {
    const realizedPnl = row ? gmxRealizedPnlUsd(row) : null
    const pnl = totalPnl ?? realizedPnl
    const aum = row ? usd(row.maxCapital) : null
    // Tier-0 on-chain-equivalent risk: GMX exposes no MDD/Sharpe, so derive
    // them from the daily cumulative-PnL series (accountPnlHistoryStats) over
    // the max-capital base. daily-approx — understates intraday DD; see
    // series-risk.ts provenance note. Returns all-null without a positive base.
    const risk = riskFromCumulativePnl(
      points.map((p) => ({ ts: new Date(p.ts).toISOString(), value: p.value })),
      aum
    )
    const riskExtras: Record<string, unknown> =
      risk.mdd !== null || risk.sharpe !== null
        ? { risk_derivation: 'daily-approx', risk_samples: risk.samples, sortino: risk.sortino }
        : {}
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: row ? roiOnMaxCapital(pnl, row) : null,
      pnl,
      sharpe: risk.sharpe, // Tier-0 daily-approx (was NULL — not exposed by GMX)
      mdd: risk.mdd, // Tier-0 daily-approx peak-to-trough on equity curve
      winRate: row ? winRatePct(row) : null,
      winPositions: row ? num(row.wins) : null,
      totalPositions: row ? (num(row.wins) ?? 0) + (num(row.losses) ?? 0) : null,
      copierPnl: null, // DEX — no copy trading
      copierCount: null,
      aum,
      volume: row ? usd(row.volume) : null,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        pnl_basis: 'total_incl_unrealized', // accountPnlHistoryStats cumulativePnl
        aum_basis: 'max_capital_proxy', // legacy-connector convention
        realized_pnl_usd: realizedPnl,
        window_from: num(payload.from),
        closed_count: row ? num(row.closedCount) : null,
        ...riskExtras,
      },
    })
  }

  if (points.length > 0) {
    series.push({
      timeframe: tf,
      metric: 'pnl', // window-cumulative incl. unrealized (GMX UI chart)
      points: points.map((p) => ({ ts: new Date(p.ts).toISOString(), value: p.value })),
    })
  }

  return { stats, series, nickname: null, avatarUrlOrigin: null }
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
