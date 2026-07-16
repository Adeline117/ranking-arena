/**
 * KuCoin Futures copy-trading ("Copy Trading Hub") pure parsers — spec §7
 * #28 / §11.17. Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-11): numerics are
 * high-precision STRINGS; rates (thirtyDayPnlRatio / totalReturnRate /
 * profitSharingRatio / chart ratio / preference percent) are plain fractions
 * ("4.3216" = 432.16%) — we store percent, matching the other adapters.
 * Timestamps are MS epochs (UTC).
 *
 * Endpoint payload shapes (base www.kucoin.com/_api/ct-copy-trade/v1/copyTrading):
 *   leaderboard: POST rn/leaderboard/query
 *                  {criteria:[], sort:{field:'ranking_score',direction:'DESC'},
 *                   hideFull:false, currentPage, pageSize≤100}
 *                → { data: { totalNum, totalPage, items: [card...] } }
 *                Board metrics are 30d-anchored (thirtyDayPnl/Ratio); the
 *                board has NO timeframe param → timeframes_native={30}.
 *   profile bundle (composite, built by the adapter, replayable from RAW):
 *     { summary, overview, pnlHistory, currencyPreference, timeframe }
 *     - leadShow/summary?leadConfigId=        identity + uid + lead days
 *     - leadShow/overview?leadConfigId=       principal/AUM/copier PnL/share
 *     - leadShow/pnl/history?leadConfigId&period={7d,30d,90d}
 *       [{pnl, ratio, statTime}] cumulative over the window → per-TF stats
 *     - leadShow/currencyPreference?leadConfigId=  preferred-assets donut
 *   orders:  GET cross/futures/lead/order?leadConfigId&pageNum&pageSize
 *            (fills; orderId is the natural key)
 *   copiers: GET leadShow/copyTraders?leadConfigId&pageNum&pageSize
 *   positions / position history: NOT public (leadShow/positionHistory
 *            answers data:null regardless of params — visibility-gated).
 *
 * TradePilot (spec §11.17 — KuCoin's AI-copy product, tagged as bot):
 * badge rows are exactly the rows whose `exchange` field is a foreign venue
 * (e.g. 'BN'); native rows carry 'KU' (verified 1:1 against badge DOM,
 * 2026-06-11) → trader_kind='bot', bot_strategy='ai'.
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
import { validateRequiredSeriesTails, type ProfileQualityReject } from '../../core/profile-quality'

type Dict = Record<string, unknown>

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
// KuCoin emits one cumulative bucket per day. Permit modest upstream gaps,
// while still distinguishing a 7D/truncated response from a 30D/90D request.
const MIN_WINDOW_COVERAGE_RATIO = 0.8

function num(v: unknown): number | null {
  let n: number
  if (typeof v === 'number') {
    n = v
  } else if (typeof v === 'string') {
    const normalized = v.trim()
    if (!DECIMAL_NUMBER.test(normalized)) return null
    n = Number(normalized)
  } else {
    return null
  }
  return Number.isFinite(n) ? n : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n)
}

/** Fraction → percent without float dust ("4.3216934574" → 432.1693). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

/**
 * KuCoin's thirtyDayPnlRatio is the exchange's own 30d ROI and is authoritative
 * for normal traders (it's principal/time-adjusted, so it legitimately differs
 * from naive pnl/current-principal by a few x). But it is occasionally broken —
 * e.g. 2.19e9 % for a trader with $20.83 PnL on $120.83 principal (~17%). Only
 * when the ratio is ABSURD (magnitude > 100000%, i.e. clearly garbage, far beyond
 * any real leveraged 30d return) do we fall back to pnl/principal, which stays
 * consistent with the PnL we display. The naive estimate is a sanity fallback,
 * not a replacement for the exchange's number.
 */
const ABSURD_ROI_PCT = 100000
function roiFromPnl(pnl: unknown, principal: unknown): number | null {
  const p = num(pnl)
  const base = num(principal)
  if (p === null || base === null || base <= 0) return null
  return Math.round((p / base) * 1e6) / 1e4
}
function kucoinHeadlineRoi(ratioField: unknown, pnl: unknown, principal: unknown): number | null {
  const ratioRoi = pct(ratioField)
  if (ratioRoi !== null && Math.abs(ratioRoi) <= ABSURD_ROI_PCT) return ratioRoi
  return roiFromPnl(pnl, principal) ?? ratioRoi
}

/** KuCoin epochs are MILLISECONDS. */
function iso(msEpoch: unknown): string | null {
  const n = num(msEpoch)
  if (n === null || n <= 0) return null
  const date = new Date(n)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}

function data(payload: unknown): unknown {
  return (payload as Dict)?.data
}

function pagedItems(payload: unknown): { items: Dict[]; total: number | null } {
  const d = data(payload) as Dict | null
  const items = Array.isArray(d?.items) ? (d.items as Dict[]) : []
  return { items, total: int(d?.totalNum) }
}

/** TradePilot rows execute on a foreign venue (exchange ≠ 'KU'). */
function isTradePilot(item: Dict): boolean {
  const ex = item.exchange
  return typeof ex === 'string' && ex.length > 0 && ex !== 'KU'
}

/** Board-row lead-principal / tenure / copier / min-copy fields (逐图核对). */
function kucoinBoardExtras(item: Dict): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const principal = num(item.leadPrincipal)
  if (principal !== null) ext.lead_principal = principal
  const days = int(item.daysAsLeader)
  if (days !== null) ext.leading_days = days
  const maxCopiers = int(item.maxCopyUserCount)
  if (maxCopiers !== null) ext.max_copier_slots = maxCopiers
  const followerPnl = num(item.followerPnl)
  if (followerPnl !== null) ext.copier_total_profit = followerPnl
  const totalPnl = num(item.totalPnl)
  if (totalPnl !== null) ext.total_pnl = totalPnl
  const totalRoi = num(item.totalPnlRatio)
  if (totalRoi !== null) ext.total_roi = Math.round(totalRoi * 100 * 100) / 100
  const minCopy = num(item.minCopyAmount)
  if (minCopy !== null) ext.min_copy_amount = minCopy
  return Object.keys(ext).length > 0 ? ext : null
}

export function parseKucoinLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const { items, total } = pagedItems(raw)
  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.leadConfigId === null || item.leadConfigId === undefined) continue
    const pilot = isTradePilot(item)
    rows.push({
      // leadConfigId is the only id the board exposes AND the routing key of
      // every profile endpoint (profile URL: /copytrading/trader-profile/{id}).
      exchangeTraderId: String(item.leadConfigId),
      rank: i + 1, // positional; re-anchored across pages by the processor
      nickname: (item.nickName as string) ?? null,
      avatarUrlOrigin:
        typeof item.avatarUrl === 'string' && item.avatarUrl.length > 0 ? item.avatarUrl : null,
      walletAddress: null,
      traderKind: pilot ? 'bot' : 'human',
      botStrategy: pilot ? 'ai' : null,
      // thirtyDayPnlRatio is the exchange's ROI (authoritative); fall back to
      // pnl/principal only when it's absurd (broken field). See kucoinHeadlineRoi.
      headlineRoi: kucoinHeadlineRoi(item.thirtyDayPnlRatio, item.thirtyDayPnl, item.leadPrincipal),
      headlinePnl: num(item.thirtyDayPnl),
      headlineWinRate: null, // not exposed on the board
      // leadAmount = Lead Size / AUM (absolute USD; identical to profile overview.aum)
      // — was raw-only, so board-tier traders had no AUM. (KuCoin exposes no MDD.)
      headlineAum: num(item.leadAmount),
      headlineCopierCount: int(item.currentCopyUserCount),
      // 逐图核对 image74/76: board row carries lead principal / tenure / copier
      // slots / follower PnL / min-copy — promote so board-tier traders show them.
      headlineExtras: kucoinBoardExtras(item),
      traderMeta: pilot ? { tradepilot: true, venue: item.exchange } : null,
      // 30-point PnL sparkline verbatim
      raw: item,
    })
  }
  return { rows, reportedTotal: total }
}

interface ProfileBundle {
  summary?: unknown
  overview?: unknown
  pnlHistory?: unknown
  currencyPreference?: unknown
  timeframe?: number
}

interface KucoinChartEvidence {
  payload_valid: boolean
  row_count: number
  invalid_row_count: number
  invalid_shape_count: number
  invalid_timestamp_count: number
  invalid_pnl_count: number
  invalid_roi_count: number
  duplicate_timestamp_count: number
}

function parseKucoinChart(payload: unknown): {
  points: Array<{ ts: string; pnl: number | null; ratio: number | null }>
  evidence: KucoinChartEvidence
} {
  const chart = data(payload)
  const evidence: KucoinChartEvidence = {
    payload_valid: Array.isArray(chart),
    row_count: 0,
    invalid_row_count: 0,
    invalid_shape_count: 0,
    invalid_timestamp_count: 0,
    invalid_pnl_count: 0,
    invalid_roi_count: 0,
    duplicate_timestamp_count: 0,
  }
  if (!Array.isArray(chart)) return { points: [], evidence }

  const pointsByTimestamp = new Map<
    string,
    { ts: string; pnl: number | null; ratio: number | null }
  >()
  for (const candidate of chart) {
    evidence.row_count += 1
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      evidence.invalid_row_count += 1
      evidence.invalid_shape_count += 1
      continue
    }
    const row = candidate as Dict
    const ts = iso(row.statTime)
    const pnl = num(row.pnl)
    const ratio = pct(row.ratio)
    if (ts === null) evidence.invalid_timestamp_count += 1
    if (pnl === null) evidence.invalid_pnl_count += 1
    if (ratio === null) evidence.invalid_roi_count += 1
    if (ts === null || pnl === null || ratio === null) evidence.invalid_row_count += 1
    if (ts === null) continue
    if (pointsByTimestamp.has(ts)) evidence.duplicate_timestamp_count += 1
    pointsByTimestamp.set(ts, { ts, pnl, ratio }) // exact-timestamp last value wins
  }

  return {
    points: [...pointsByTimestamp.values()].sort((left, right) => left.ts.localeCompare(right.ts)),
    evidence,
  }
}

/**
 * Profile bundle, one per TF. Per-TF roi/pnl come from the LAST point of the
 * cumulative pnl/history chart for that window; the overview block
 * (principal/AUM/copier PnL/share rate) is window-insensitive.
 */
export function parseKucoinProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 30) as Timeframe
  const summary = data(bundle.summary) as Dict | null
  const overview = data(bundle.overview) as Dict | null
  const prefs = data(bundle.currencyPreference)
  const { points, evidence: chartEvidence } = parseKucoinChart(bundle.pnlHistory)
  const last = points.length > 0 ? points[points.length - 1] : null

  const stats: ParsedStats[] = []
  if (overview || summary || last) {
    const extras: Record<string, unknown> = {}
    if (overview?.leadPrincipal !== undefined) {
      extras.lead_principal = num(overview.leadPrincipal)
    }
    if (overview?.totalReturnRate !== undefined) {
      extras.total_return_rate = pct(overview.totalReturnRate)
    }
    if (summary?.uid !== null && summary?.uid !== undefined) {
      extras.exchange_uid = String(summary.uid)
    }
    if (summary?.leadDays !== undefined) extras.lead_days = int(summary.leadDays)
    if (summary?.followersSum !== undefined) extras.follower_count = int(summary.followersSum)
    if (summary?.introduce) extras.introduction = summary.introduce
    if (summary?.exchange) extras.venue = summary.exchange
    if (isTradePilot(summary ?? {})) extras.tradepilot = true
    if (summary?.allowCopyTraders !== undefined) {
      extras.max_copier_slots = int(summary.allowCopyTraders)
    }
    // 交易频率 — inferred trades-per-DAY (cross-check: ~1028 lifetime positions /
    // 137 leadDays ≈ 7.5/day, same order as the reported 10; a per-week reading
    // would be ~5× too low). Same domain concept as gate's verified-per-day
    // trading_frequency. Keep raw + a per-week alias (×7) so trades_per_week
    // displays; provenance flagged here if a future capture disproves the unit.
    if (overview?.tradingFrequency !== undefined) {
      const perDay = num(overview.tradingFrequency)
      if (perDay !== null) {
        extras.trading_frequency = perDay
        extras.trade_frequency = Math.round(perDay * 7 * 100) / 100
      }
    }

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: last?.ratio ?? null, // cumulative window ratio (chart last point)
      pnl: last?.pnl ?? null,
      sharpe: null,
      mdd: null, // not exposed
      winRate: null, // not exposed
      winPositions: null,
      totalPositions: null,
      copierPnl: num(overview?.copyTradingPnl),
      copierCount: int(summary?.alreadyCopyTraders),
      aum: num(overview?.aum),
      volume: null,
      profitShareRate: pct(overview?.profitSharingRatio),
      holdingDurationAvgHours: null,
      tradingPreferences: Array.isArray(prefs) ? { currencies: prefs } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const pnlPoints = points
    .filter((p) => p.pnl !== null)
    .map((p) => ({ ts: p.ts, value: p.pnl as number }))
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })
  const roiPoints = points
    .filter((p) => p.ratio !== null)
    .map((p) => ({ ts: p.ts, value: p.ratio as number }))
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })

  return {
    stats,
    series,
    replaceSeries:
      chartEvidence.payload_valid &&
      chartEvidence.row_count > 0 &&
      chartEvidence.invalid_row_count === 0 &&
      pnlPoints.length > 0 &&
      roiPoints.length > 0
        ? [{ timeframe: tf, metrics: ['pnl', 'roi'] }]
        : [],
    nickname: summary ? ((summary.nickName as string) ?? null) : null,
    avatarUrlOrigin: summary ? ((summary.avatar as string) ?? null) : null,
  }
}

/** KuCoin derives scalar ROI/PnL from its daily pnl/history chart. A stopped
 *  chart must reject the whole profile instead of being stamped freshly. */
export function validateKucoinProfile(
  profile: ParsedProfile,
  ctx: ParseCtx,
  requestedTimeframe: Timeframe,
  raw: unknown
): ProfileQualityReject[] {
  const timeframe = requestedTimeframe === 0 ? 90 : requestedTimeframe
  const stat = profile.stats.find((candidate) => candidate.timeframe === timeframe)
  const rawLeadDays = stat?.extras.lead_days
  const leadDays =
    typeof rawLeadDays === 'number' && Number.isFinite(rawLeadDays) && rawLeadDays >= 0
      ? Math.floor(rawLeadDays)
      : null
  const expectedDays = Math.min(timeframe, Math.max(1, leadDays ?? timeframe))
  const minPointCount = Math.max(1, Math.ceil(expectedDays * MIN_WINDOW_COVERAGE_RATIO))
  const minCoverageSpanMs =
    expectedDays <= 1 ? 0 : Math.floor((expectedDays - 1) * MIN_WINDOW_COVERAGE_RATIO) * 86_400_000

  const rejects = validateRequiredSeriesTails(profile, ctx, requestedTimeframe, {
    requiredMetrics: ['pnl', 'roi'],
    minPointCount,
    minCoverageSpanMs,
  })
  const bundle = (raw ?? {}) as ProfileBundle
  const rawEvidence = parseKucoinChart(bundle.pnlHistory).evidence
  const rawBlockingReasons: string[] = []
  if (!rawEvidence.payload_valid) rawBlockingReasons.push('profile_series_payload_invalid')
  if (rawEvidence.invalid_row_count > 0) {
    rawBlockingReasons.push('profile_series_point_invalid')
  }
  if (rawBlockingReasons.length === 0) return rejects

  const existing = rejects[0]
  const existingReasons = Array.isArray(existing?.payload.blocking_reasons)
    ? existing.payload.blocking_reasons.filter(
        (reason): reason is string => typeof reason === 'string'
      )
    : existing
      ? [existing.reason]
      : []
  const blockingReasons = [...new Set([...existingReasons, ...rawBlockingReasons])]
  return [
    {
      reason: existing?.reason ?? rawBlockingReasons[0],
      payload: {
        ...(existing?.payload ?? {
          requested_timeframe: requestedTimeframe,
          canonical_timeframe: timeframe,
          scraped_at: ctx.scrapedAt,
        }),
        blocking_reasons: blockingReasons,
        raw_chart: rawEvidence,
      },
    },
  ]
}

/** Current positions are not publicly exposed (visibility-gated). */
export function parseKucoinPositions(_raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  return []
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/** tradeSide "OPEN_SHORT" → { orderKind: 'OPEN', side: 'short' }. */
function splitTradeSide(v: unknown): { orderKind: string | null; side: string | null } {
  if (typeof v !== 'string' || v.length === 0) return { orderKind: null, side: null }
  const [kind, dir] = v.split('_')
  return {
    orderKind: kind ?? null,
    side: dir === 'LONG' ? 'long' : dir === 'SHORT' ? 'short' : null,
  }
}

/**
 * Orders tab (GET cross/futures/lead/order): lead-order fills, newest first;
 * orderId is the stable natural key (venue-prefixed, e.g. "BN-294…").
 */
export function parseKucoinOrders(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const { items } = pagedItems(raw)
  const out: ParsedHistoryRow[] = []
  for (const item of items) {
    const ts = iso(item.tradeTime)
    if (!item.symbolCode || ts === null) continue
    const { orderKind, side } = splitTradeSide(item.tradeSide)
    out.push({
      kind: 'orders',
      ts,
      orderKind,
      symbol: String(item.symbolCode),
      side,
      price: num(item.dealPrice),
      qty: num(item.dealSize),
      dedupeHash: item.orderId
        ? dedupeHash('kucoin_or', item.orderId)
        : dedupeHash('kucoin_or', item.symbolCode, item.tradeTime, item.dealPrice, item.dealSize),
      raw: item,
    })
  }
  return out
}

/**
 * Copy Traders tab (GET leadShow/copyTraders). nickName is a masked email —
 * stored for dedupe/aggregates only, NEVER rendered (spec §6 copier PII).
 * No row timestamp → ts = ctx.scrapedAt.
 */
export function parseKucoinCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const { items } = pagedItems(raw)
  const out: ParsedHistoryRow[] = []
  for (const item of items) {
    if (item.nickName === undefined || item.nickName === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(item.nickName),
      copierPnl: num(item.pnl),
      copierInvested: num(item.copyPrincipal),
      copyDurationDays: int(item.copyDays),
      dedupeHash: dedupeHash('kucoin_cp', item.nickName, item.copyPrincipal, item.copyDays),
      raw: item,
    })
  }
  return out
}

export function parseKucoinHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'orders':
      return parseKucoinOrders(raw, ctx)
    case 'copiers':
      return parseKucoinCopiers(raw, ctx)
    default:
      // position history answers data:null (visibility-gated); no transfers.
      throw new Error(`[kucoin] history surface ${kind} not supported`)
  }
}
