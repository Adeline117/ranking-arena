/**
 * LBank Futures copy-trading pure parsers — spec §7 #37 / §11.22.
 * Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-11): numerics are
 * STRINGS and rates are ALREADY PERCENT ("5.71" = 5.71%, drawDown "14.21" =
 * 14.21%) — unlike every other batch-1 source's fractions; num() passes
 * them through, no ×100. Board/chart epochs are MS; position/history
 * endpoints use SECONDS (string) epochs.
 *
 * Board model (spec §11.22 — 7/30 only; 14D/180D labels IGNORED):
 * GET trader/stat/v1/getAll?…&topFlag=0&sortField={rankingValue|owRankingValue}
 * → { data: { total, pages, records } }. The sortField prefix selects the
 * window AND re-computes the s*-prefixed "selected" fields server-side
 * (verified: sprofitRate 5.71→6.28 switching rankingValue→owRankingValue):
 *   s*  = selected window (sprofitRate/sprofit/swinRate/sfollowerIncome,
 *         drawDown)            ← headline source
 *   om* = one-month fixed copies; bare profitRate/profit/winRate = all-time
 * topFlag=1 is the curated "Top Lead traders" carousel — never crawled.
 *
 * Profile endpoints (base uuapi.rerrkvifj.com/futures-follow-center/trader):
 *   stat/v1/{openId}/head/info               identity + bio + slots
 *   stat/v1/get?type={1w,1m,all}&traderId=   Performance block per window
 *   stat/v1/queryProfitRate (POST {openId, periodType})  PnL% chart
 *     (.profitRateSum = cumulative), queryProfit (cumulative PnL),
 *     queryTradeVolume (vol bars), queryTradePreference (token donut)
 *     periodType: 1=24h, 2=7d, 4=30d (3/5 = ignored 14d/180d)
 *   trade/v1/positions/{openId}              current lead positions
 *   stat/v1/position/history?…&startTime&endTime (SECONDS)  closed positions
 *   stat/v1/followers?current&size&traderId  copy traders (PII)
 *
 * posiDirection semantics are UNVERIFIED (CTP-style enum) → side stays null
 * with the raw field preserved; never guess (spec §5 accuracy-first).
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

/** Board/chart epochs are MILLISECONDS. */
function isoMs(msEpoch: unknown): string | null {
  const n = num(msEpoch)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

/** Position/history epochs are SECONDS (often strings). */
function isoSec(secEpoch: unknown): string | null {
  const n = num(secEpoch)
  return n === null || n <= 0 ? null : new Date(n * 1000).toISOString()
}

function data(payload: unknown): unknown {
  return (payload as Dict)?.data
}

function pagedRecords(payload: unknown): { records: Dict[]; total: number | null } {
  const d = data(payload) as Dict | null
  const records = Array.isArray(d?.records) ? (d.records as Dict[]) : []
  return { records, total: int(d?.total) }
}

/** Avatar base verified from the rendered DOM (relative headPhoto paths). */
const AVATAR_BASE = 'https://www.lbank.com/static-old-backend'

function avatarUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  if (v.startsWith('http')) return v
  if (v.startsWith('/')) return `${AVATAR_BASE}${v}`
  return null
}

export function parseLbankLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const { records, total } = pagedRecords(raw)
  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < records.length; i++) {
    const item = records[i]
    if (!item.uuid) continue
    rows.push({
      exchangeTraderId: String(item.uuid),
      rank: i + 1, // positional; re-anchored across pages by the processor
      nickname: ((item.localNickname ?? item.nickname) as string) ?? null,
      avatarUrlOrigin: avatarUrl(item.headPhoto),
      walletAddress: null,
      traderKind: 'human', // no bot product on this board
      botStrategy: null,
      // s* fields = the window selected by the request's sortField prefix;
      // values are ALREADY percent.
      headlineRoi: num(item.sprofitRate),
      headlinePnl: num(item.sprofit),
      headlineWinRate: num(item.swinRate),
      // Board carries drawDown (already percent — "14.21" = 14.21%, per header) and
      // AUM (followerBalance, absolute). Extract them — were raw-only, capping
      // lbank's MDD/AUM at top-N-profile coverage.
      headlineMdd: num(item.drawDown),
      headlineAum: num(item.followerBalance),
      traderMeta: null,
      // sfollowerIncome, copier slots, medal badges, level,
      // 31-point sparkline... kept verbatim.
      raw: item,
    })
  }
  return { rows, reportedTotal: total }
}

interface ProfileBundle {
  headInfo?: unknown
  stat?: unknown
  profitRateChart?: unknown
  profitChart?: unknown
  volumeChart?: unknown
  tradePreference?: unknown
  timeframe?: number
}

/** [{dateTime ms, <valueKey>}] chart rows → series points. */
function chartPoints(
  payload: unknown,
  valueKey: string,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  const rows = data(payload)
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows as Dict[]) {
    const ts = isoMs(row.dateTime)
    const value = decode(row[valueKey])
    if (ts === null || value === null) continue
    points.push({ ts, value })
  }
  return points
}

/**
 * Profile bundle, one per TF (7/30). The Performance block (stat/v1/get) is
 * genuinely window-scoped via type=1w|1m.
 */
export function parseLbankProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = (bundle.timeframe === 7 ? 7 : 30) as Timeframe
  const head = data(bundle.headInfo) as Dict | null
  const stat = data(bundle.stat) as Dict | null
  const prefs = data(bundle.tradePreference)

  const stats: ParsedStats[] = []
  if (stat) {
    const extras: Record<string, unknown> = {}
    if (head?.introduction) extras.introduction = head.introduction
    if (head?.traderLevel !== undefined) extras.trader_level = int(head.traderLevel)
    if (head?.maxFollowers !== undefined) extras.max_copier_slots = int(head.maxFollowers)
    if (head?.currentFollowers !== undefined) {
      extras.current_followers = int(head.currentFollowers)
    }
    if (stat.openPositions !== undefined) extras.open_positions = int(stat.openPositions)
    if (stat.countCloseOrders !== undefined) {
      extras.closed_positions = int(stat.countCloseOrders)
    }
    if (stat.followProfitNum !== undefined) {
      extras.profitable_copier_count = int(stat.followProfitNum)
    }
    // Lifetime trade count — headInfo exposes it; surfaces as the lifetime_trades
    // metric (Phase A: was raw-only).
    if (head?.totalTransactionNum !== undefined) {
      extras.lifetime_trades = int(head.totalTransactionNum)
    }
    // 累计跟单人数 + 带单天数 (逐图核对) — headInfo carries both, were unpromoted.
    if (head?.accumulatedFollowers !== undefined) {
      extras.copier_count_history = int(head.accumulatedFollowers)
    }
    if (head?.days !== undefined) extras.leading_days = int(head.days)

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: num(stat.profitRate), // already percent
      pnl: num(stat.profit),
      sharpe: null,
      mdd: num(stat.drawDown), // already percent
      winRate: num(stat.winRate), // already percent
      winPositions: null, // only order-level win counts exposed (raw)
      totalPositions: int(stat.tradeCount),
      copierPnl: num(stat.followerIncome),
      copierCount: int(stat.followerCount),
      aum: num(stat.followerBalance),
      volume: null, // daily volume bars in series instead
      profitShareRate: num(head?.profitShareRatio), // headInfo 分润比例 (percent)
      holdingDurationAvgHours: null, // holding-duration module not captured
      tradingPreferences: Array.isArray(prefs) ? { instruments: prefs } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  // Copy Trading PnL chart: profitRateSum = cumulative PnL% (already %).
  const roiPoints = chartPoints(bundle.profitRateChart, 'profitRateSum', num)
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = chartPoints(bundle.profitChart, 'profit', num)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })
  const volPoints = chartPoints(bundle.volumeChart, 'volume', num)
  if (volPoints.length > 0) {
    series.push({ timeframe: tf, metric: 'volume_daily', points: volPoints })
  }

  return {
    stats,
    series,
    nickname: head ? (((head.localNickname ?? head.nickname) as string) ?? null) : null,
    avatarUrlOrigin: head ? avatarUrl(head.headImage) : null,
  }
}

/**
 * Current lead positions (GET trade/v1/positions/{openId}, plain array).
 * posiDirection enum unverified → side null (raw preserved).
 */
export function parseLbankPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const list = data(raw)
  if (!Array.isArray(list)) return []
  const out: ParsedPosition[] = []
  for (const item of list as Dict[]) {
    if (!item.instrumentID) continue
    out.push({
      symbol: String(item.instrumentID),
      side: null, // posiDirection semantics unverified — never guess
      leverage: num(item.leverage),
      size: num(item.position),
      entryPrice: num(item.costPrice) ?? num(item.openPrice),
      markPrice: null,
      unrealizedPnl: null, // not exposed on this endpoint
      raw: item,
    })
  }
  return out
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/**
 * Order History tab (GET stat/v1/position/history): closed positions,
 * newest first; positionID is the natural key. SECONDS epochs.
 */
export function parseLbankPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const { records } = pagedRecords(raw)
  const out: ParsedHistoryRow[] = []
  for (const item of records) {
    if (!item.instrumentID) continue
    out.push({
      kind: 'position_history',
      openedAt: isoSec(item.insertTime),
      closedAt: isoSec(item.closeTime),
      symbol: String(item.instrumentID),
      side: null, // direction/posiDirection enums unverified
      leverage: num(item.leverage),
      size: num(item.volume),
      entryPrice: num(item.positionOpenPrice) ?? num(item.openPrice),
      exitPrice: num(item.closePrice),
      realizedPnl: num(item.closeProfit),
      dedupeHash: item.positionID
        ? dedupeHash('lbank_ph', item.positionID)
        : dedupeHash('lbank_ph', item.instrumentID, item.insertTime, item.closeTime),
      raw: item,
    })
  }
  return out
}

/**
 * Copy traders tab (GET stat/v1/followers; the board card only previews the
 * top 3 — copier_table_depth='top3_preview' refers to that card preview,
 * the tab endpoint paginates the full list). name is masked — stored for
 * dedupe/aggregates only, NEVER rendered (spec §6 copier PII).
 */
export function parseLbankCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const { records } = pagedRecords(raw)
  const out: ParsedHistoryRow[] = []
  for (const item of records) {
    if (item.name === undefined || item.name === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(item.name),
      copierPnl: num(item.totalProfit),
      copierInvested: null, // only lifetime volume exposed (raw.totalVol)
      copyDurationDays: int(item.followDays),
      dedupeHash: dedupeHash('lbank_cp', item.name, item.followDays, item.totalProfit),
      raw: item,
    })
  }
  return out
}

export function parseLbankHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseLbankPositionHistory(raw, ctx)
    case 'copiers':
      return parseLbankCopiers(raw, ctx)
    default:
      // order-level fills and transfers are not exposed publicly.
      throw new Error(`[lbank] history surface ${kind} not supported`)
  }
}
