/**
 * Blofin pure parsers (spec §11.14) — work on stored RAW payloads only
 * (re-parse guarantee, spec §5.5).
 *
 * One adapter serves blofin_futures + blofin_spot via src.meta.boardKey. The
 * "All Traders" board is a POST endpoint that returns FULL per-TF stats per
 * trader plus a cumulative-ROI chart, so the leaderboard crawl alone covers
 * the per-TF profile-stats requirement (the dedicated profile page is a
 * click-guarded SPA route with no reachable per-uid JSON endpoint):
 *   futures: POST /uapi/v1/copy/v2/trader/list
 *   spot:    POST /sapi/v1/spot_copy/trader/list
 *   body: {sort_field:"roi", range_time:"1"|"2"|"3" (=7|30|90d), page_num,
 *          page_size, trading_bots_type:[], tag_list:[], ...}
 *   data: {trader_info[], page_total, pages, page_num, page_size, range_time}
 *
 * Row (decimals): roi, mdd; plus pnl, aum, sharpe_ratio, followers,
 * followers_max, verified, and chart_data.roi[{time(ms), data}] (per-TF
 * cumulative ROI series, kept verbatim in raw). The board exposes no
 * per-row bot flag — trader_kind defaults to human; the Trading Bots
 * dropdown (trading_bots_type filter) would need a separate tagging pass
 * (documented gap).
 *
 * Verified by live capture 2026-06-11 (blofin-*-debug scripts, deleted).
 */

import { createHash } from 'crypto'
import type {
  BoardSeriesBlock,
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  ParsedStats,
  RankingTimeframe,
} from '../../core/types'

type Dict = Record<string, unknown>

/** Stable natural identity for idempotent record upserts (spec §2.3). */
function blofinDedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/** ms epoch → ISO, or null. */
function isoMs(v: unknown): string | null {
  const n = num(v)
  if (n === null || n <= 0) return null
  return new Date(n).toISOString()
}

/** data[] of a {code,data} record envelope. */
function dataRows(raw: unknown): Dict[] {
  const d = (raw as Dict)?.data
  return Array.isArray(d) ? (d as Dict[]) : []
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

/** Blofin roi/mdd are decimal fractions (4.5583 = 455.83%). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

function traderInfo(payload: unknown): Dict[] {
  const data = (payload as Dict)?.data as Dict | undefined
  const list = data?.trader_info
  return Array.isArray(list) ? (list as Dict[]) : []
}

/**
 * trader/list page → per-TF rows. The full row (mdd, sharpe_ratio, aum,
 * followers, verified, chart_data) is preserved in raw (spec §3) — it is the
 * per-TF profile-stats substrate since no per-uid profile endpoint exists.
 */
export function parseBlofinLeaderboardPage(
  payload: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const rows: ParsedLeaderboardRow[] = []
  const list = traderInfo(payload)
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const id = item.uid
    if (id === null || id === undefined) continue
    rows.push({
      exchangeTraderId: String(id),
      rank: i + 1, // sorted list; re-anchored across pages by the caller
      nickname: typeof item.nick_name === 'string' ? item.nick_name : null,
      avatarUrlOrigin: typeof item.profile === 'string' ? item.profile : null,
      walletAddress: null,
      // No per-row bot flag (only the trading_bots_type FILTER distinguishes
      // them) — default human; bot tagging is a documented gap.
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.roi),
      headlinePnl: num(item.pnl),
      headlineWinRate: null, // not exposed on the board row
      // Blofin has NO per-uid profile endpoint, so the board IS the stats
      // substrate (spec §0): carry mdd/sharpe/aum/copier_count straight into
      // trader_stats via the publish headline upsert. mdd is a decimal
      // fraction (×100); followers = current copier count.
      headlineMdd: pct(item.mdd),
      headlineSharpe: num(item.sharpe_ratio),
      headlineAum: num(item.aum),
      headlineCopierCount: int(item.followers),
      raw: item,
    })
  }
  const total = int(((payload as Dict)?.data as Dict | undefined)?.page_total)
  return { rows, reportedTotal: total }
}

/**
 * Board-level free series (spec §13.1): each board row embeds
 * `chart_data.roi` = {time(ms), data} — a per-TF cumulative ROI series
 * (decimal fraction, ×100), so EVERY ranked trader gets a chart with no
 * extra fetch. Blofin has NO per-uid profile endpoint (parseProfile is a
 * no-op), so the board is the ONLY series source. The board is per-TF
 * (range_time), so points belong to `timeframe`.
 */
/**
 * Per-trader profile (headful-discovered endpoints, 2026-07-02). Adds the
 * risk metrics the board omits — sharpe/sortino/calmar/volatility/annualized_roi
 * — plus per-symbol trading preferences + the roi/pnl chart. Scales match the
 * board (roi/mdd/win_ratio are decimal fractions → pct()×100); sharpe/sortino/
 * calmar are raw ratios blofin computes itself. Every field NULL-collapses.
 */
export function parseBlofinProfile(rawPayload: unknown, ctx: ParseCtx): ParsedProfile {
  const p = (rawPayload ?? {}) as Dict
  const tf = (num(p.timeframe) ?? 90) as RankingTimeframe
  const ind = ((p.indicators as Dict)?.data ?? null) as Dict | null
  const info = ((p.info as Dict)?.data ?? null) as Dict | null
  const symbolPerf = ((p.symbolPerf as Dict)?.data as Dict | null)?.symbols
  const perf = (p.performance as Dict)?.data

  const stats: ParsedStats[] = []
  if (ind) {
    const extras: Record<string, unknown> = {}
    const put = (k: string, v: number | null) => {
      if (v !== null) extras[k] = v
    }
    put('sortino', num(ind.sortino_ratio))
    put('calmar', num(ind.calmar_ratio))
    put('volatility', num(ind.volatility))
    put('down_risk', num(ind.down_risk))
    put('annualized_roi', pct(ind.annualized_roi))
    put('copier_pnl', num(ind.copier_volume))

    // Per-symbol trading preferences (AssetPreference reads .assets[{asset,volume}]).
    let tradingPreferences: Record<string, unknown> | null = null
    if (Array.isArray(symbolPerf) && symbolPerf.length > 0) {
      const assets = (symbolPerf as Dict[])
        .map((s) => ({
          asset: typeof s.symbol === 'string' ? s.symbol : null,
          volume: num(s.ratio),
          win_rate: pct(s.win_ratio),
          trades: int(s.trades),
        }))
        .filter((a) => a.asset !== null)
      if (assets.length > 0) tradingPreferences = { assets }
    }

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(ind.roi),
      pnl: num(ind.real_pnl ?? ind.pnl_all),
      sharpe: num(ind.sharpe_ratio),
      mdd: pct(ind.max_drawdown),
      winRate: pct(ind.win_ratio_all),
      winPositions: int(ind.winning_trades),
      totalPositions: int(ind.trades),
      copierPnl: null,
      copierCount: null,
      aum: null,
      volume: num(ind.trade_volume),
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  if (Array.isArray(perf)) {
    const roiPts: Array<{ ts: string; value: number }> = []
    const pnlPts: Array<{ ts: string; value: number }> = []
    for (const row of perf as Dict[]) {
      const t = num(row.time)
      if (t === null || t <= 0) continue
      const ts = new Date(t).toISOString()
      const r = pct(row.roi)
      const pnl = num(row.total_pnl)
      if (r !== null) roiPts.push({ ts, value: r })
      if (pnl !== null) pnlPts.push({ ts, value: pnl })
    }
    roiPts.sort((a, b) => (a.ts < b.ts ? -1 : 1))
    pnlPts.sort((a, b) => (a.ts < b.ts ? -1 : 1))
    if (roiPts.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPts })
    if (pnlPts.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPts })
  }

  return {
    stats,
    series,
    nickname: info && typeof info.nick_name === 'string' ? info.nick_name : null,
    avatarUrlOrigin: info && typeof info.profile === 'string' ? info.profile : null,
  }
}

export function parseBlofinLeaderboardSeries(
  payload: unknown,
  _ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  for (const item of traderInfo(payload)) {
    const id = item.uid
    if (id === null || id === undefined) continue
    const chartData = (item.chart_data ?? null) as Dict | null
    const roi = Array.isArray(chartData?.roi) ? (chartData!.roi as Dict[]) : []
    const points = roi
      .map((p) => ({ t: num(p.time), value: pct(p.data) }))
      .filter((p): p is { t: number; value: number } => p.t !== null && p.t > 0 && p.value !== null)
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ ts: new Date(p.t).toISOString(), value: p.value }))
    if (points.length > 0) out.set(String(id), [{ timeframe, metric: 'roi', points }])
  }
  return out
}

// ── Record surfaces (public unsigned uapi, discovered 2026-07-02) ────────────
// The detail-page UI tabs are login-gated, but the underlying uapi endpoints
// are PUBLIC + unsigned (same as the profile stat endpoints):
//   POST /uapi/v1/copy/trader/order/list    {uid} → current OPEN positions
//        (close_time=null; mark_price/unrealized_pnl)
//   POST /uapi/v1/copy/trader/order/history {uid} → CLOSED positions
//        (open/close time+price, order_side, leverage, roe)
//   POST /uapi/v1/copy/trader/copiers       {uid} → copiers (nick_name masked)
// Blofin order rows carry position_side=NET, so direction = order_side
// (BUY=long, SELL=short). History rows expose roe (return ratio) but not a
// per-position realized-PnL amount → realizedPnl left honest-null, roe in raw.

/** Current open positions (order/list, close_time==null) → ParsedPosition[].
 *  Blofin is NET mode and order/list returns per-ORDER rows, so multiple
 *  sub-orders share one (symbol, side) net position — they MUST be aggregated
 *  (size summed, entry size-weighted) or the (trader,symbol,side) upsert key
 *  collides ("ON CONFLICT cannot affect row a second time"). */
export function parseBlofinPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const byKey = new Map<
    string,
    {
      symbol: string
      side: string | null
      leverage: number | null
      size: number
      notional: number
      upnl: number | null
      mark: number | null
      rows: Dict[]
    }
  >()
  for (const r of dataRows(raw)) {
    if (r.close_time !== null && r.close_time !== undefined) continue // closed → history surface
    const symbol = typeof r.symbol === 'string' ? r.symbol : null
    if (!symbol) continue
    const side = typeof r.order_side === 'string' ? r.order_side : null
    const key = `${symbol}|${side}`
    const size = num(r.quantity) ?? 0
    const entry = num(r.avg_open_price)
    const upnl = num(r.unrealized_pnl)
    const agg = byKey.get(key) ?? {
      symbol,
      side,
      leverage: num(r.leverage),
      size: 0,
      notional: 0,
      upnl: null,
      mark: num(r.mark_price),
      rows: [],
    }
    agg.size += size
    if (entry !== null) agg.notional += size * entry
    if (upnl !== null) agg.upnl = (agg.upnl ?? 0) + upnl
    if (agg.mark === null) agg.mark = num(r.mark_price)
    agg.rows.push(r)
    byKey.set(key, agg)
  }
  return [...byKey.values()].map((a) => ({
    symbol: a.symbol,
    side: a.side,
    leverage: a.leverage,
    size: a.size > 0 ? a.size : null,
    entryPrice: a.size > 0 && a.notional > 0 ? a.notional / a.size : null, // size-weighted avg
    markPrice: a.mark,
    unrealizedPnl: a.upnl,
    raw: a.rows.length === 1 ? a.rows[0] : { aggregated_orders: a.rows },
  }))
}

/** Closed-position history (order/history) + copiers (trader/copiers). */
export function parseBlofinHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  if (kind === 'position_history') {
    const out: ParsedHistoryRow[] = []
    for (const r of dataRows(raw)) {
      const symbol = typeof r.symbol === 'string' ? r.symbol : null
      if (!symbol) continue
      out.push({
        kind: 'position_history',
        openedAt: isoMs(r.open_time),
        closedAt: isoMs(r.close_time) ?? ctx.scrapedAt,
        symbol,
        side: typeof r.order_side === 'string' ? r.order_side : null,
        leverage: num(r.leverage),
        size: num(r.quantity),
        entryPrice: num(r.avg_open_price),
        exitPrice: num(r.avg_close_price),
        realizedPnl: num(r.real_pnl), // often null; roe rides in raw
        dedupeHash: blofinDedupeHash('blofin_ph', r.id_md5 ?? r.id, r.close_time),
        raw: r,
      })
    }
    return out
  }

  if (kind === 'copiers') {
    const out: ParsedHistoryRow[] = []
    for (const c of dataRows(raw)) {
      const label = typeof c.nick_name === 'string' ? c.nick_name : null
      out.push({
        kind: 'copiers',
        ts: ctx.scrapedAt,
        copierLabel: label, // exchange-masked; stored for dedupe/aggregation only (spec §6)
        copierPnl: num(c.return_amount),
        copierInvested: num(c.cum_invested ?? c.amount),
        copyDurationDays: int(c.follower_days),
        dedupeHash: blofinDedupeHash('blofin_cp', c.id ?? label, c.follow_time),
        raw: c,
      })
    }
    return out
  }

  return [] // orders / transfers not exposed by blofin
}
