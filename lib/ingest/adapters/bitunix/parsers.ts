/**
 * Bitunix Futures copy-trading pure parsers — spec §7 #24 / §11.16.
 * Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-11):
 *   - roi / winRate / mdd / shareRatio are FRACTIONS ("0.874816" = 87.48%,
 *     "0.1000" = 10%) — we store percent (Bitget/Bybit convention).
 *   - EXCEPTION: position-history profitRate is ALREADY percent ("14.13" —
 *     cross-checked: +0.57% price move × 28x leverage ≈ 15.9%).
 *   - pl / aum / amounts are plain USDT strings; timestamps are ISO-8601 Z
 *     strings; chart dates are ints (20260604) labeled UTC+0 (§11.16).
 *   - side: 1 = short, 2 = long — verified against price direction vs PnL
 *     sign on live positions (BTC long side=2 profited on a rise; ADA
 *     side=1 lost on a rise).
 *
 * Composite payload shapes (built by the adapter, replayable from RAW):
 *   profile bundle: { statistic, detail, timeframe }
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

/** Fraction → percent without float dust (0.874816 → 87.4816). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

/** ISO-8601 Z string → normalized ISO (null on anything unparsable). */
function iso(v: unknown): string | null {
  if (typeof v !== 'string' || v === '') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** Chart date int 20260604 → UTC midnight ISO (charts are UTC+0-labeled). */
function dateIntIso(v: unknown): string | null {
  const n = int(v)
  if (n === null || n < 19000101 || n > 99991231) return null
  const s = String(n)
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`
}

function data(payload: unknown): Dict | null {
  const d = (payload as Dict)?.data
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Dict) : null
}

/** Bitunix side: 1 = short, 2 = long (see header note). */
function side(v: unknown): 'long' | 'short' | null {
  const n = int(v)
  if (n === 2) return 'long'
  if (n === 1) return 'short'
  return null
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/** {date, amount}[] → series points (decode = pct for roi, num for pnl). */
function dailyPoints(
  list: unknown,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  if (!Array.isArray(list)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const item of list as Dict[]) {
    const ts = dateIntIso(item.date)
    const value = decode(item.amount)
    if (ts === null || value === null) continue
    points.push({ ts, value })
  }
  return points
}

/**
 * 交易專家 board (POST trader/list {statisticType,oderType,nickname,page,
 * pageSize,version:1} — "oderType" is Bitunix's own typo, verified live).
 * statisticType selects the window: 1=7d, 2=30d, 3=90d (4=180d ignored).
 */
export function parseBitunixLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const d = data(raw)
  const items = Array.isArray(d?.records) ? (d.records as Dict[]) : []
  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.uid === undefined || item.uid === null) continue
    rows.push({
      exchangeTraderId: String(item.uid),
      // Positional in-page rank; re-anchored across pages by the caller.
      rank: i + 1,
      nickname: (item.nickname as string) || null,
      avatarUrlOrigin: (item.header as string) || null,
      walletAddress: null,
      // No structured bot flag on Bitunix (nicknames like "Ai Agent" are
      // not a reliable signal) — all rows are human (spec §1.3).
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.roi),
      headlinePnl: num(item.pl),
      headlineWinRate: pct(item.winRate),
      // The board row carries per-TF mdd (a FRACTION, like roi/winRate — see header
      // doc), so extract it to headlineMdd (publish writes it to trader_stats.mdd).
      // Was previously left only in raw → board-tier traders had no MDD, leaving
      // bitunix at ~20% capture (only top-N profiled traders got it).
      headlineMdd: pct(item.mdd),
      // dailyWinRate sparkline, aum, copier slots, symbolList, full,
      // privateMode... kept verbatim (spec §3 raw JSONB note).
      raw: item,
    })
  }
  return { rows, reportedTotal: int(d?.total) }
}

/**
 * Board-level free series (spec §13.1): each board row embeds a
 * `dailyWinRate` = {date:int, amount} cumulative ROI sparkline (amount is a
 * decimal fraction → pct, matching the profile's `dailyPoints(s.dailyWinRate,
 * pct)` decode) and sometimes `dailyPl` (cumulative PnL). The board is
 * per-TF (statisticType in the request), so the points belong to
 * `timeframe`. Every ranked trader gets a chart with no extra fetch.
 */
export function parseBitunixLeaderboardSeries(
  raw: unknown,
  _ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  const d = data(raw)
  const items = Array.isArray(d?.records) ? (d.records as Dict[]) : []
  for (const item of items) {
    if (item.uid === undefined || item.uid === null) continue
    const blocks: BoardSeriesBlock[] = []
    const roiPoints = dailyPoints(item.dailyWinRate, pct) // 收益率 (cumulative, %)
    if (roiPoints.length > 0) blocks.push({ timeframe, metric: 'roi', points: roiPoints })
    const pnlPoints = dailyPoints(item.dailyPl, num) // 盈虧 (cumulative, USDT)
    if (pnlPoints.length > 0) blocks.push({ timeframe, metric: 'pnl', points: pnlPoints })
    if (blocks.length > 0) out.set(String(item.uid), blocks)
  }
  return out
}

interface ProfileBundle {
  statistic?: unknown
  detail?: unknown
  timeframe?: number
}

/**
 * Profile bundle, one per TF (statisticType 1/2/3 = 7/30/90):
 *   statistic: POST trader/statistic → 帶單表現 stats block + 收益率/盈虧
 *              daily cumulative series + 交易偏好 donut (10-min refresh)
 *   detail:    POST trader/detail    → 帶單員總覽 (AUM, 帶單保證金餘額,
 *              跟單人數 x/500, 總跟單人數, 交易天數, 分潤比例)
 */
export function parseBitunixProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 30) as Timeframe
  const s = data(bundle.statistic)
  const detail = data(bundle.detail)

  const stats: ParsedStats[] = []
  if (s) {
    const winCount = int(s.winCount)
    const lossCount = int(s.lossCount)
    const extras: Record<string, unknown> = {}
    if (lossCount !== null) extras.loss_count = lossCount
    if (detail) {
      extras.trade_days = num(detail.tradeDays)
      extras.lead_margin_balance = num(detail.secAmount) // 帶單保證金餘額
      extras.copier_limit = int(detail.maxFollow)
      extras.total_copiers_history = int(detail.totalFollow) // 總跟單人數
      extras.min_invest = num(detail.minInvest)
      extras.trade_amount = num(detail.tradeAmount)
      if (typeof detail.briefInfo === 'string' && detail.briefInfo) extras.bio = detail.briefInfo
      if (detail.privateMode !== undefined) extras.private_mode = detail.privateMode === true
    }

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(s.roi),
      pnl: num(s.pl),
      sharpe: null,
      mdd: pct(s.mdd),
      winRate: pct(s.winRate),
      winPositions: winCount,
      totalPositions: winCount !== null && lossCount !== null ? winCount + lossCount : null,
      copierPnl: num(s.followerPnl), // 跟單人盈虧
      copierCount: detail ? int(detail.currentFollow) : null,
      aum: detail ? num(detail.aum) : null,
      volume: null,
      profitShareRate: detail ? pct(detail.shareRatio) : null, // 分潤比例
      holdingDurationAvgHours: null, // not exposed
      tradingPreferences: Array.isArray(s.symbolList) ? { symbols: s.symbolList } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = dailyPoints(s?.dailyWinRate, pct) // 收益率 (cumulative, %)
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = dailyPoints(s?.dailyPl, num) // 盈虧 (cumulative, USDT)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })

  return {
    stats,
    series,
    nickname: detail ? ((detail.nickname as string) ?? null) : null,
    avatarUrlOrigin: detail ? ((detail.header as string) ?? null) : null,
  }
}

/**
 * 當前帶單 (GET trader/position/pending?traderUid=): rich open positions —
 * mark price, unrealized PnL and ROE are all public here.
 */
export function parseBitunixPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const list = Array.isArray((raw as Dict)?.data) ? ((raw as Dict).data as Dict[]) : []
  const out: ParsedPosition[] = []
  for (const item of list) {
    if (!item.symbol) continue
    out.push({
      symbol: String(item.symbol),
      side: side(item.side),
      leverage: num(item.leverage),
      size: num(item.amount),
      entryPrice: num(item.openPrice),
      markPrice: num(item.markPrice),
      unrealizedPnl: num(item.profitUnreal),
      raw: item,
    })
  }
  return out
}

/**
 * 歷史帶單 (GET trader/position/history?traderUid&page&pageSize): closed
 * lead positions, newest first; id is the stable natural key. ctime=open,
 * mtime=close. profitRate is ALREADY percent (see header note).
 */
export function parseBitunixPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.records) ? (d.records as Dict[]) : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    if (!item.symbol) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.ctime),
      closedAt: iso(item.mtime),
      symbol: String(item.symbol),
      side: side(item.side),
      leverage: num(item.leverage),
      size: num(item.amount),
      entryPrice: num(item.openPrice),
      exitPrice: num(item.closePrice),
      realizedPnl: num(item.profitReal),
      dedupeHash: item.id
        ? dedupeHash('bitunix_ph', item.id)
        : dedupeHash('bitunix_ph', item.symbol, item.ctime, item.mtime, item.amount),
      raw: item,
    })
  }
  return out
}

/**
 * 跟單者 (POST trader/follow/list). nickname is a partially-masked email —
 * stored for dedupe/aggregates only, NEVER rendered (spec §6 copier PII).
 * `day` = copy duration in days; followAmount = invested.
 */
export function parseBitunixCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw)
  const list = Array.isArray(d?.records) ? (d.records as Dict[]) : []
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const uid = item.uid
    if (uid === undefined || uid === null) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String((item.nickname as string) || uid),
      copierPnl: num(item.pl),
      copierInvested: num(item.followAmount),
      copyDurationDays: int(item.day),
      dedupeHash: dedupeHash('bitunix_cp', uid, item.followDate),
      raw: item,
    })
  }
  return out
}

export function parseBitunixHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseBitunixPositionHistory(raw, ctx)
    case 'copiers':
      return parseBitunixCopiers(raw, ctx)
    default:
      // order-level records and transfers are not exposed publicly.
      throw new Error(`[bitunix] history surface ${kind} not supported`)
  }
}
