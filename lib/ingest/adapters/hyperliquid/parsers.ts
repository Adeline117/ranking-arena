/**
 * Hyperliquid pure parsers (spec §7 #31, docs/hyperliquid-spike.md).
 *
 * Inputs are the composite RAW payloads the adapter stores:
 *   leaderboard page: { timeframe, reportedTotal, rows }  (rows = a chunk of
 *     the stats-data S3 file, already sorted+truncated fetch-side — see the
 *     spike doc §6 for why RAW keeps the truncated board)
 *   profile bundle:   { portfolio, clearinghouse, timeframe }
 *   positions:        the clearinghouseState response verbatim
 *
 * Unit ground truth (verified live 2026-06-11 + legacy connector 2026-04-20):
 *   - windowPerformances roi is a DECIMAL FRACTION → ×100 to canonical percent
 *   - accountValue is EQUITY (AUM), never PnL
 *   - portfolio pnlHistory is CUMULATIVE within its window (allTime =
 *     cumulative since inception, sampled ~weekly, last point ≈ fetch time)
 */

import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  ParsedStats,
  RankingTimeframe,
  Timeframe,
} from '../../core/types'
import { riskFromEquitySeries } from '../../core/series-risk'
import { fillStats, reconstructRoundTrips, type HlFill } from './fills'
import { createHash } from 'crypto'

type Dict = Record<string, unknown>

/** windowPerformances / portfolio window keys per canonical timeframe. */
export const TF_WINDOW: Record<RankingTimeframe, string> = {
  7: 'week',
  30: 'month',
  90: 'allTime', // 90 is DERIVED from allTime by interpolation (spike §3)
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Clamp canonical-percent ROI like the legacy connector (Arena Score caps
 *  at 10000% internally anyway; a few HL accounts exceed it). */
function clampRoiPct(roi: number | null): number | null {
  if (roi === null) return null
  return Math.max(-10_000, Math.min(10_000, roi))
}

/**
 * windowPerformances comes as tuples [["week", {...}], ...] from stats-data;
 * tolerate the object form {week: {...}} the old info endpoint used.
 */
function windowPerf(row: Dict, windowKey: string): Dict | null {
  const wp = row.windowPerformances
  if (Array.isArray(wp)) {
    const hit = wp.find((pair) => Array.isArray(pair) && pair[0] === windowKey)
    return hit ? ((hit as [string, Dict])[1] ?? null) : null
  }
  if (wp && typeof wp === 'object') {
    return ((wp as Record<string, Dict>)[windowKey] as Dict) ?? null
  }
  return null
}

// ── Leaderboard ──

export function parseHyperliquidLeaderboardPage(
  raw: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as {
    timeframe?: unknown
    reportedTotal?: unknown
    rows?: unknown
  }
  const timeframe = (num(payload.timeframe) ?? 7) as RankingTimeframe
  const windowKey = TF_WINDOW[timeframe] ?? 'week'
  const items = Array.isArray(payload.rows) ? (payload.rows as Dict[]) : []

  const rows: ParsedLeaderboardRow[] = []
  for (const item of items) {
    const address = String(item.ethAddress ?? item.user ?? '')
      .trim()
      .toLowerCase()
    if (!address.startsWith('0x')) continue // no identity → cannot publish

    const perf = windowPerf(item, windowKey)
    const rawRoi = num(perf?.roi)
    rows.push({
      exchangeTraderId: address,
      rank: rows.length + 1, // chunk-local; tier-a re-anchors by page_size
      nickname: typeof item.displayName === 'string' && item.displayName ? item.displayName : null,
      avatarUrlOrigin: null, // no avatars on-chain
      walletAddress: address, // spec §1.4 on-chain identity
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: clampRoiPct(rawRoi === null ? null : rawRoi * 100),
      headlinePnl: num(perf?.pnl),
      headlineWinRate: null, // needs fills analysis — out of v1 (spike §8.3)
      // accountValue = the trader's on-chain equity (absolute USD) — the board IS
      // the authoritative source for AUM here, and the leaderboard covers ~382k
      // traders far beyond profile-crawl reach, so capture it for everyone.
      headlineAum: num(item.accountValue),
      traderMeta: null,
      raw: item, // all 4 windows + vlm, verbatim (spec §3)
    })
  }

  return { rows, reportedTotal: num(payload.reportedTotal) }
}

// ── Profile ──

type HistPoint = [number, string | number]

interface PortfolioWindow {
  accountValueHistory?: HistPoint[]
  pnlHistory?: HistPoint[]
  vlm?: string | number
}

/** portfolio response is [[windowKey, data], ...]; tolerate object form. */
function portfolioWindow(portfolio: unknown, windowKey: string): PortfolioWindow | null {
  if (Array.isArray(portfolio)) {
    const hit = portfolio.find((pair) => Array.isArray(pair) && pair[0] === windowKey)
    return hit ? ((hit as [string, PortfolioWindow])[1] ?? null) : null
  }
  if (portfolio && typeof portfolio === 'object') {
    return ((portfolio as Record<string, PortfolioWindow>)[windowKey] as PortfolioWindow) ?? null
  }
  return null
}

function histPoints(hist: HistPoint[] | undefined): Array<{ ts: number; value: number }> {
  if (!Array.isArray(hist)) return []
  const out: Array<{ ts: number; value: number }> = []
  for (const p of hist) {
    if (!Array.isArray(p)) continue
    const ts = num(p[0])
    const value = num(p[1])
    if (ts !== null && value !== null) out.push({ ts, value })
  }
  return out.sort((a, b) => a.ts - b.ts)
}

/** Linear interpolation on a sorted [ts,value] history; clamps to ends. */
export function lerpAt(points: Array<{ ts: number; value: number }>, t: number): number | null {
  if (points.length === 0) return null
  if (t <= points[0].ts) return points[0].value
  if (t >= points[points.length - 1].ts) return points[points.length - 1].value
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]
    const b = points[i + 1]
    if (a.ts <= t && t <= b.ts) {
      if (b.ts === a.ts) return a.value
      return a.value + ((b.value - a.value) * (t - a.ts)) / (b.ts - a.ts)
    }
  }
  return points[points.length - 1].value
}

const DAY_MS = 86_400_000

const isoMs = (ms: number) => new Date(ms).toISOString()

function seriesFrom(
  timeframe: Timeframe,
  metric: string,
  points: Array<{ ts: number; value: number }>
): ParsedProfile['series'][number] | null {
  if (points.length === 0) return null
  return { timeframe, metric, points: points.map((p) => ({ ts: isoMs(p.ts), value: p.value })) }
}

const EMPTY_STATS: Omit<
  ParsedStats,
  'timeframe' | 'asOf' | 'roi' | 'pnl' | 'aum' | 'volume' | 'extras'
> = {
  sharpe: null, // not exposed / not computed — NULL collapses in UI
  mdd: null, // ~weekly equity samples would understate DD — deliberately NULL
  winRate: null, // needs fills replay — out of v1 (spike §8.3)
  winPositions: null,
  totalPositions: null,
  copierPnl: null, // DEX — no copy trading
  copierCount: null,
  profitShareRate: null,
  holdingDurationAvgHours: null,
  tradingPreferences: null,
}

/**
 * Profile = portfolio + clearinghouseState (spike §2-3).
 *   7/30: native window — pnl is the window's cumulative end value, ROI on a
 *         start-equity basis; series straight from the window histories.
 *   90:   derived — lerp the cumulative allTime histories at (scrapedAt−90d);
 *         series = allTime points inside the window, PnL rebased to 0 at the
 *         window start. Disclosed via extras.derivation.
 */
export function parseHyperliquidProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const payload = (raw ?? {}) as {
    portfolio?: unknown
    clearinghouse?: unknown
    fills?: unknown
    timeframe?: unknown
  }
  const tfNum = num(payload.timeframe) ?? 30
  const tf = (tfNum === 0 ? 90 : tfNum) as RankingTimeframe

  const ch = (payload.clearinghouse ?? null) as Dict | null
  const marginSummary = (ch?.marginSummary ?? null) as Dict | null
  const aum = num(marginSummary?.accountValue)

  // M3-3a fills replay: round-trip reconstruction over the TF window gives the
  // CEX-equivalent winRate / positions / holding-time / 盈亏比 that HL never
  // hands over ("needs fills replay — spike §8.3", now in). NULL-collapses when
  // the fills fetch failed or the window has no completed trips.
  const fillsArr = Array.isArray(payload.fills) ? (payload.fills as HlFill[]) : []
  const fstats =
    fillsArr.length > 0 ? fillStats(fillsArr, Date.parse(ctx.scrapedAt) - tf * DAY_MS, tf) : null
  const hasTrips = fstats !== null && fstats.totalPositions > 0
  const fillsExtras: Record<string, unknown> = {}
  if (hasTrips) {
    fillsExtras.fills_derivation = 'fills-replay'
    if (fstats.pnlRatio !== null) fillsExtras.pnl_ratio = fstats.pnlRatio
    if (fstats.tripsPerWeek !== null) fillsExtras.trades_per_week = fstats.tripsPerWeek
  }

  const stats: ParsedStats[] = []
  const series: ParsedProfile['series'] = []
  const push = (s: ParsedProfile['series'][number] | null) => {
    if (s) series.push(s)
  }

  if (tf === 7 || tf === 30) {
    const win = portfolioWindow(payload.portfolio, TF_WINDOW[tf])
    if (win) {
      const pnlPts = histPoints(win.pnlHistory)
      const eqPts = histPoints(win.accountValueHistory)
      const pnl = pnlPts.length > 0 ? pnlPts[pnlPts.length - 1].value : null
      const startEquity = eqPts.length > 0 ? eqPts[0].value : null
      const roi =
        pnl !== null && startEquity !== null && startEquity > 0
          ? clampRoiPct((pnl / startEquity) * 100)
          : null
      // Tier-0 risk from the REAL equity history (accountValueHistory) — true
      // peak-to-trough MDD, no base reconstruction. Sample-limited → daily-approx.
      const risk = riskFromEquitySeries(eqPts.map((p) => ({ ts: isoMs(p.ts), value: p.value })))
      const riskExtras: Record<string, unknown> =
        risk.mdd !== null || risk.sharpe !== null
          ? { risk_derivation: 'daily-approx', risk_samples: risk.samples, sortino: risk.sortino }
          : {}
      stats.push({
        timeframe: tf,
        asOf: ctx.scrapedAt,
        roi,
        pnl,
        aum,
        volume: num(win.vlm),
        extras: { roi_basis: 'start_equity', ...riskExtras, ...fillsExtras },
        ...EMPTY_STATS,
        sharpe: risk.sharpe, // Tier-0 (overrides EMPTY_STATS null)
        mdd: risk.mdd,
        // M3-3a fills replay (overrides EMPTY_STATS nulls when trips exist)
        winRate: hasTrips ? fstats.winRate : null,
        winPositions: hasTrips ? fstats.winPositions : null,
        totalPositions: hasTrips ? fstats.totalPositions : null,
        holdingDurationAvgHours: hasTrips ? fstats.avgHoldingHours : null,
      })
      push(seriesFrom(tf, 'pnl', pnlPts))
      push(seriesFrom(tf, 'account_value', eqPts))
    }
  } else {
    // 90d derived from allTime interpolation (spike §3, method 2)
    const win = portfolioWindow(payload.portfolio, 'allTime')
    if (win) {
      const pnlPts = histPoints(win.pnlHistory)
      const eqPts = histPoints(win.accountValueHistory)
      const windowStart = Date.parse(ctx.scrapedAt) - 90 * DAY_MS
      const pnlNow = pnlPts.length > 0 ? pnlPts[pnlPts.length - 1].value : null
      const pnlAnchor = lerpAt(pnlPts, windowStart)
      const eqAnchor = lerpAt(eqPts, windowStart)
      const pnl = pnlNow !== null && pnlAnchor !== null ? pnlNow - pnlAnchor : null
      const roi =
        pnl !== null && eqAnchor !== null && eqAnchor > 0
          ? clampRoiPct((pnl / eqAnchor) * 100)
          : null
      // Tier-0 risk on the in-window equity slice (allTime equity ≥ windowStart).
      const eqInWindow = eqPts.filter((p) => p.ts >= windowStart)
      const risk = riskFromEquitySeries(
        eqInWindow.map((p) => ({ ts: isoMs(p.ts), value: p.value }))
      )
      const riskExtras: Record<string, unknown> =
        risk.mdd !== null || risk.sharpe !== null
          ? { risk_derivation: 'daily-approx', risk_samples: risk.samples, sortino: risk.sortino }
          : {}
      stats.push({
        timeframe: 90,
        asOf: ctx.scrapedAt,
        roi,
        pnl,
        aum,
        volume: null, // only allTime vlm exists — no honest 90d volume
        extras: {
          derivation: 'portfolio_alltime_lerp',
          roi_basis: 'start_equity',
          ...riskExtras,
          ...fillsExtras,
        },
        ...EMPTY_STATS,
        sharpe: risk.sharpe, // Tier-0 (overrides EMPTY_STATS null)
        mdd: risk.mdd,
        // M3-3a fills replay (overrides EMPTY_STATS nulls when trips exist)
        winRate: hasTrips ? fstats.winRate : null,
        winPositions: hasTrips ? fstats.winPositions : null,
        totalPositions: hasTrips ? fstats.totalPositions : null,
        holdingDurationAvgHours: hasTrips ? fstats.avgHoldingHours : null,
      })
      const inWindow = pnlPts.filter((p) => p.ts >= windowStart)
      push(
        seriesFrom(
          90,
          'pnl',
          pnlAnchor === null ? [] : inWindow.map((p) => ({ ts: p.ts, value: p.value - pnlAnchor }))
        )
      )
      push(
        seriesFrom(
          90,
          'account_value',
          eqPts.filter((p) => p.ts >= windowStart)
        )
      )
    }
  }

  return { stats, series, nickname: null, avatarUrlOrigin: null }
}

// ── Positions ──

/** clearinghouseState.assetPositions → current open positions (Tier D). */
export function parseHyperliquidPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const ch = (raw ?? {}) as Dict
  const assetPositions = Array.isArray(ch.assetPositions) ? (ch.assetPositions as Dict[]) : []

  const out: ParsedPosition[] = []
  for (const ap of assetPositions) {
    const pos = (ap.position ?? null) as Dict | null
    if (!pos || typeof pos.coin !== 'string') continue
    const szi = num(pos.szi)
    if (szi === null || szi === 0) continue
    const size = Math.abs(szi)
    const positionValue = num(pos.positionValue)
    const leverage = num((pos.leverage as Dict | undefined)?.value)
    out.push({
      symbol: pos.coin,
      side: szi > 0 ? 'long' : 'short',
      leverage,
      size,
      entryPrice: num(pos.entryPx),
      // No mark price field; positionValue = |szi| × mark, so recover it.
      markPrice: positionValue !== null && size > 0 ? positionValue / size : null,
      unrealizedPnl: num(pos.unrealizedPnl),
      raw: pos,
    })
  }
  return out
}

// ── Histories ──

/** M3-3a: position_history = closed round-trips rebuilt from userFillsByTime
 *  (lib/ingest/adapters/hyperliquid/fills.ts). Other surfaces stay unsupported. */
export function parseHyperliquidHistory(
  raw: unknown,
  kind: HistoryKind,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  if (kind !== 'position_history') {
    throw new Error(`[hyperliquid] history surface ${kind} not supported`)
  }
  const fills = (raw as Dict)?.fills
  const arr = Array.isArray(fills) ? (fills as HlFill[]) : []
  return reconstructRoundTrips(arr).map((t) => ({
    kind: 'position_history' as const,
    openedAt: isoMs(t.openedAtMs),
    closedAt: isoMs(t.closedAtMs),
    symbol: t.coin,
    side: t.side,
    leverage: null, // fills don't carry leverage; positions surface has it live
    size: t.size,
    entryPrice: Math.round(t.entryPrice * 1e6) / 1e6,
    exitPrice: Math.round(t.exitPrice * 1e6) / 1e6,
    realizedPnl: t.realizedPnl,
    dedupeHash: createHash('sha1')
      .update(['hl_ph', t.coin, t.openedAtMs, t.closedAtMs, t.realizedPnl].join('|'))
      .digest('hex'),
    raw: {
      coin: t.coin,
      fills: t.fills,
      from_flip: t.fromFlip,
      max_size: t.size,
    },
  }))
}
