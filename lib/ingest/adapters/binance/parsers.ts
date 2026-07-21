/**
 * Binance copy-trading pure parsers (spec §11.1) — work on stored RAW
 * payloads only. One parser set serves binance_futures + binance_spot; the
 * two endpoint families return near-identical envelopes:
 *
 *   futures: /bapi/futures/v1/.../future/copy-trade/...        (query-list)
 *   spot:    /bapi/futures/v1/.../future/spot-copy-trade/...   (home-page-list)
 *
 * Envelope: { code: "000000", data: {...} }. Units (verified by live
 * capture 2026-06-11): roi/mdd/winRate already PERCENT, pnl/aum quote
 * units, timestamps ms epochs. Binance EXPOSES Sharpe (`sharpRatio`,
 * string in some payloads) — mapped to stats.sharpe. Spot performance has
 * `winDays` instead of winOrders/totalOrder (→ extras.win_days).
 */

import { createHash } from 'crypto'
import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  ParsedStats,
  Timeframe,
} from '../../core/types'

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

function iso(msEpoch: unknown): string | null {
  const ms = num(msEpoch)
  return ms === null ? null : new Date(ms).toISOString()
}

function dataOf(payload: unknown): Dict | null {
  const data = (payload as Dict)?.data
  return data && typeof data === 'object' && !Array.isArray(data) ? (data as Dict) : null
}

function listOf(payload: unknown): Dict[] {
  const data = dataOf(payload)
  const list = data?.list
  return Array.isArray(list) ? (list as Dict[]) : []
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

// ── Leaderboard ──

/**
 * Futures query-list / spot home-page-list share one row shape:
 * { leadPortfolioId, nickname, avatarUrl, roi, pnl, aum, mdd, sharpRatio,
 *   currentCopyCount, maxCopyCount, chartItems[], ... }.
 * Futures rows additionally expose winRate/copierPnl/badgeName/aiSummary.
 * roi/mdd/winRate are already percent. leadPortfolioId is the identity —
 * the profile URL is /en/copy-trading/lead-details/{leadPortfolioId}.
 */
export function parseBinanceLeaderboardPage(
  payload: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const data = dataOf(payload)
  const reportedTotal = int(data?.total)
  const items = listOf(payload)

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.leadPortfolioId
    if (!id) continue
    const headlineRoi = num(item.roi)
    const headlinePnl = num(item.pnl)
    const headlineWinRate = num(item.winRate)
    rows.push({
      exchangeTraderId: String(id),
      // Sort order is the rank; re-anchored across pages by the caller.
      rank: i + 1,
      nickname: typeof item.nickname === 'string' ? item.nickname : null,
      avatarUrlOrigin: typeof item.avatarUrl === 'string' ? item.avatarUrl : null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi,
      headlinePnl,
      headlineWinRate, // spot rows don't expose it → null
      headlineMetricSources: {
        ...(headlineRoi === null ? {} : { roi: { fieldPath: 'data.list[].roi' } }),
        ...(headlinePnl === null ? {} : { pnl: { fieldPath: 'data.list[].pnl' } }),
        ...(headlineWinRate === null ? {} : { win_rate: { fieldPath: 'data.list[].winRate' } }),
      },
      // The board carries aum as an absolute USD amount on every row — extract it
      // (was raw-only, so AUM came only from the deep-profile tier). MDD/sharpe on
      // the board are 0/null sentinels (real values are profile-only), so not lifted.
      headlineAum: num(item.aum),
      // copierPnl is a REAL value on every board row (verified — fixture 2972.33),
      // was captured only for deep-crawled profiles (~17% fill). Lift it so all
      // binance traders get copier PnL (audit 2026-07-03).
      headlineCopierPnl: num(item.copierPnl),
      // Board card extras (sharpRatio, mdd, sparkline chartItems,
      // badge, aiSummary...) ride along verbatim in raw.
      raw: item,
    })
  }
  return { rows, reportedTotal }
}

// ── Profile ──

/** chart-data / performance-chart-data: [{ value, dataType, dateTime }] —
 *  cumulative daily series, value percent for ROI / quote units for PNL. */
function chartPoints(payload: unknown): Array<{ ts: string; value: number }> {
  const data = (payload as Dict)?.data
  if (!Array.isArray(data)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of data as Dict[]) {
    const ts = num(row.dateTime)
    const value = num(row.value)
    if (ts === null || value === null) continue
    points.push({ ts: new Date(ts).toISOString(), value })
  }
  return points
}

/**
 * Profile bundle as assembled by the adapter (all verified 2026-06-11):
 *   detail:      GET friendly/.../lead-portfolio/detail?portfolioId=
 *                (TF-independent Lead Trader Overview: AUM, margin balance,
 *                 profit share %, min copy, copier counts, sharpRatio)
 *   performance: GET public/.../lead-portfolio/performance?portfolioId&timeRange
 *                futures: { roi, pnl, mdd, copierPnl, winRate, winOrders,
 *                           totalOrder, sharpRatio }
 *                spot:    { aum, roi, pnl, mdd, copierPnl, winRate, winDays,
 *                           sharpRatio } (strings)
 *   chartRoi/chartPnl: chart-data?dataType=ROI|PNL (daily cumulative)
 *   coinPreference: performance(/coin|coin-preference) — Asset Preferences
 *                   donut { timeRange, updateTime, data: [{asset, volume%}] }
 */
export function parseBinanceProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as {
    detail?: Dict
    performance?: Dict
    chartRoi?: Dict
    chartPnl?: Dict
    coinPreference?: Dict
    timeframe?: number
  }
  const tf = (bundle.timeframe ?? 90) as Timeframe
  const det = dataOf(bundle.detail)
  const perf = dataOf(bundle.performance)
  const pref = dataOf(bundle.coinPreference)

  const stats: ParsedStats[] = []
  if (perf) {
    const extras: Record<string, unknown> = {}
    if (perf.winDays !== undefined) extras.win_days = int(perf.winDays) // spot only
    if (det) {
      // TF-independent Lead Trader Overview (spec §11.1) → extras
      const margin = det.marginBalance ?? det.walletBalanceAmount // futures | spot
      if (margin !== undefined) extras.margin_balance = num(margin)
      if (det.fixedRadioMinCopyUsd !== undefined)
        extras.min_copy_fixed_ratio_usd = num(det.fixedRadioMinCopyUsd)
      if (det.fixedAmountMinCopyUsd !== undefined)
        extras.min_copy_fixed_amount_usd = num(det.fixedAmountMinCopyUsd)
      if (det.maxCopyCount !== undefined) extras.copier_count_max = int(det.maxCopyCount)
      if (det.totalCopyCount !== undefined) extras.copier_count_total = int(det.totalCopyCount)
      if (det.favoriteCount !== undefined) extras.favorite_count = int(det.favoriteCount)
      if (det.startTime !== undefined) extras.lead_start_time = iso(det.startTime)
      if (det.lastTradeTime !== undefined) extras.last_trade_time = iso(det.lastTradeTime)
      if (typeof det.badgeName === 'string') extras.badge_name = det.badgeName
      if (typeof det.aiSummary === 'string') extras.ai_summary = det.aiSummary
      if (typeof det.futuresType === 'string') extras.futures_type = det.futuresType
      if (det.joinDays !== undefined) extras.days_trading = int(det.joinDays) // spot
    }

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: num(perf.roi), // already percent
      pnl: num(perf.pnl),
      sharpe: num(perf.sharpRatio ?? det?.sharpRatio), // Binance exposes Sharpe!
      mdd: num(perf.mdd), // already percent
      winRate: num(perf.winRate), // already percent
      winPositions: int(perf.winOrders), // futures only
      totalPositions: int(perf.totalOrder), // futures only
      copierPnl: num(perf.copierPnl),
      copierCount: int(det?.currentCopyCount),
      aum: num(perf.aum ?? det?.aumAmount), // spot perf | futures detail
      volume: null,
      profitShareRate: num(det?.profitSharingRate), // percent (e.g. "15.00")
      holdingDurationAvgHours: null,
      tradingPreferences: pref
        ? { update_time: iso(pref.updateTime), assets: pref.data ?? null }
        : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = chartPoints(bundle.chartRoi)
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = chartPoints(bundle.chartPnl)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })

  return {
    stats,
    series,
    nickname: det && typeof det.nickname === 'string' ? det.nickname : null,
    avatarUrlOrigin: det && typeof det.avatarUrl === 'string' ? det.avatarUrl : null,
  }
}

// ── Positions ──

/** 'Long'/'Short' labels and BUY/SELL sides → canonical lowercase. */
function side(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  const s = v.toLowerCase()
  if (s === 'long' || s === 'buy') return 'long'
  if (s === 'short' || s === 'sell') return 'short'
  return s
}

/**
 * Two shapes, sniffed by envelope:
 *   futures lead-data/positions: data = ARRAY of positionRisk-style rows for
 *     EVERY symbol — rows with positionAmount 0 are placeholders, filter
 *     them. positionAmount is SIGNED (negative = short); positionSide is
 *     usually 'BOTH' (one-way mode) so direction comes from the sign.
 *   spot get-active-holding-by-page: data.list of holdings { asset, symbol,
 *     remainAmount, avgBuyPrice, lastPrice, unrealizedPnl } → long-only.
 */
export function parseBinancePositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const data = (raw as Dict)?.data
  const out: ParsedPosition[] = []

  if (Array.isArray(data)) {
    // futures
    for (const item of data as Dict[]) {
      const amount = num(item.positionAmount)
      if (!item.symbol || amount === null || amount === 0) continue
      const ps = typeof item.positionSide === 'string' ? item.positionSide : 'BOTH'
      out.push({
        symbol: String(item.symbol),
        side: ps === 'LONG' || ps === 'SHORT' ? ps.toLowerCase() : amount > 0 ? 'long' : 'short',
        leverage: num(item.leverage),
        size: amount, // signed base-asset quantity (spec §11.1 "Size (signed)")
        entryPrice: num(item.entryPrice),
        markPrice: num(item.markPrice),
        unrealizedPnl: num(item.unrealizedProfit),
        raw: item,
      })
    }
    return out
  }

  // spot holdings
  for (const item of listOf(raw)) {
    if (!item.symbol && !item.asset) continue
    out.push({
      symbol: String(item.symbol ?? item.asset),
      side: 'long', // spot holdings are long by construction
      leverage: null,
      size: num(item.remainAmount),
      entryPrice: num(item.avgBuyPrice),
      markPrice: num(item.lastPrice),
      unrealizedPnl: num(item.unrealizedPnl),
      raw: item,
    })
  }
  return out
}

// ── Histories (spec §2.3 incremental) ──

/** History RAW pages are wrapped by the adapter as
 *  { portfolioId, sort?, response } so dedupe hashes can include the
 *  portfolio id — Binance row ids (ms epochs) are NOT globally unique and
 *  the arena.* dedupe index is global, not per-trader. */
interface HistoryWrapper {
  portfolioId?: unknown
  sort?: unknown
  response?: unknown
}

/**
 * Futures position-history rows (POST lead-portfolio/position-history,
 * captured 2026-06-11): { id (ms epoch = opened ts), symbol, opened, closed,
 * avgCost, avgClosePrice, closingPnl, maxOpenInterest, closedVolume,
 * isolated ('Cross'|'Isolated'), side ('Long'|'Short'), status ('All
 * Closed'|'Partially Closed'), leverage ('50'), roi }. The endpoint serves
 * BOTH sort views (sort=OPENING|CLOSING); rows seen twice collapse onto the
 * same dedupe hash.
 */
function parsePositionHistory(wrapper: HistoryWrapper): ParsedHistoryRow[] {
  const pid = String(wrapper.portfolioId ?? '')
  const out: ParsedHistoryRow[] = []
  for (const item of listOf(wrapper.response)) {
    if (!item.symbol) continue
    const symbol = String(item.symbol)
    out.push({
      kind: 'position_history',
      openedAt: iso(item.opened),
      closedAt: iso(item.closed),
      symbol,
      side: side(item.side),
      leverage: num(item.leverage),
      size: num(item.closedVolume), // closed volume in base-asset units
      entryPrice: num(item.avgCost),
      exitPrice: num(item.avgClosePrice),
      realizedPnl: num(item.closingPnl),
      dedupeHash: dedupeHash('binance_ph', pid, item.id, symbol, item.side),
      raw: item,
    })
  }
  return out
}

/**
 * Latest Records (futures order-history) and spot trade history both map to
 * the orders kind:
 *   futures: { symbol, side BUY/SELL, type LIMIT/MARKET, positionSide,
 *              executedQty, avgPrice, totalPnl, orderTime } — requires a
 *              REAL startTime/endTime window (-1 is rejected externally).
 *   spot get-trade-history-by-page: { time, symbol, side, executed, price,
 *              totalAmount, fee, feeAsset, role TAKER/MAKER } — fills have
 *              NO id and identical fills DO occur, so the hash includes the
 *              occurrence index among identical siblings within the payload
 *              (deterministic on stored RAW).
 */
function parseOrders(wrapper: HistoryWrapper): ParsedHistoryRow[] {
  const pid = String(wrapper.portfolioId ?? '')
  const out: ParsedHistoryRow[] = []
  const seen = new Map<string, number>()
  for (const item of listOf(wrapper.response)) {
    const ts = iso(item.orderTime ?? item.time)
    if (ts === null || !item.symbol) continue
    const isFuturesOrder = item.orderTime !== undefined
    const base = dedupeHash(
      'binance_or',
      pid,
      item.orderTime ?? item.time,
      item.symbol,
      item.side,
      item.executedQty ?? item.executed,
      item.avgPrice ?? item.price
    )
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    out.push({
      kind: 'orders',
      ts,
      orderKind:
        (typeof item.type === 'string' && item.type) ||
        (typeof item.role === 'string' && item.role) ||
        null,
      symbol: String(item.symbol),
      side: side(item.side),
      price: num(item.avgPrice ?? item.price),
      qty: num(item.executedQty ?? item.executed),
      dedupeHash: occurrence === 0 ? base : dedupeHash(base, occurrence),
      raw: isFuturesOrder ? item : { ...item, occurrence },
    })
  }
  return out
}

/**
 * Transfer history (futures only): { time, coin, amount, from, to,
 * transType LEAD_DEPOSIT|LEAD_WITHDRAW } — direction is relative to the
 * lead-trading account (deposit = in).
 */
function parseTransfers(wrapper: HistoryWrapper): ParsedHistoryRow[] {
  const pid = String(wrapper.portfolioId ?? '')
  const out: ParsedHistoryRow[] = []
  for (const item of listOf(wrapper.response)) {
    const ts = iso(item.time)
    if (ts === null) continue
    const t = typeof item.transType === 'string' ? item.transType : ''
    out.push({
      kind: 'transfers',
      ts,
      direction: t.includes('DEPOSIT') ? 'in' : t.includes('WITHDRAW') ? 'out' : null,
      asset: typeof item.coin === 'string' ? item.coin : null,
      amount: num(item.amount),
      dedupeHash: dedupeHash('binance_tr', pid, item.time, item.coin, item.amount, t),
      raw: item,
    })
  }
  return out
}

/**
 * Copy Traders (counts/aggregates only — PII rules §6 apply downstream):
 *   futures copy-traders: { copyPortfolioId, nickname (masked),
 *     marginBalance, totalPnl, totalRoi, createTime }
 *   spot get-copy-trader-result-by-page: { nickname (masked),
 *     balanceAmount, totalPnl, totalRoi, startTime } — no stable id.
 */
function parseCopiers(wrapper: HistoryWrapper, ctx: ParseCtx): ParsedHistoryRow[] {
  const pid = String(wrapper.portfolioId ?? '')
  const scrapedMs = Date.parse(ctx.scrapedAt)
  const out: ParsedHistoryRow[] = []
  for (const item of listOf(wrapper.response)) {
    const label = item.copyPortfolioId ?? item.nickname
    if (!label) continue
    const started = num(item.createTime ?? item.startTime)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(label), // stored for dedupe only — NEVER rendered
      copierPnl: num(item.totalPnl),
      copierInvested: num(item.marginBalance ?? item.balanceAmount),
      copyDurationDays:
        started !== null && Number.isFinite(scrapedMs)
          ? Math.max(0, Math.floor((scrapedMs - started) / 86_400_000))
          : null,
      dedupeHash: dedupeHash('binance_cp', pid, label, started),
      raw: item,
    })
  }
  return out
}

export function parseBinanceHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  const wrapper = (raw ?? {}) as HistoryWrapper
  switch (kind) {
    case 'position_history':
      return parsePositionHistory(wrapper)
    case 'orders':
      return parseOrders(wrapper)
    case 'transfers':
      return parseTransfers(wrapper)
    case 'copiers':
      return parseCopiers(wrapper, ctx)
    default:
      throw new Error(`[binance] history surface ${kind as string} not supported`)
  }
}
