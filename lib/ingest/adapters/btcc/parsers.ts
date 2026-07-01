/**
 * BTCC Futures copy-trading pure parsers — spec §7 #23 / §11.15.
 * Currency is USDT (sources.currency).
 *
 * Number conventions (verified by live capture 2026-06-11):
 *   - rateProfit / winRate / dayTotalProfitRate are ALREADY percent
 *     (353.67 = 353.67%).
 *   - Board maxBackRate is BASIS POINTS (5676.00 = 56.76%) but the profile
 *     `gain` endpoint's maxBackRate is ALREADY percent (56.76) — verified by
 *     comparing both for the same trader. Board rows keep raw verbatim;
 *     profile stats use gain's percent value directly.
 *   - avgPostionTimes is seconds (sic — BTCC's own typo), shareProfitRate
 *     percent (12 = 12%), timestamps ms epochs, settleDate "YYYY-MM-DD" UTC.
 *   - direction: 1 = long, 2 = short (inferred from the common CN-platform
 *     convention; raw kept verbatim for re-interpretation).
 *
 * The 30d board's rateProfit equals the profile `profit` series' final
 * dayTotalProfitRate (window PnL ÷ window cost base) — so per-TF stats.roi
 * from that series is consistent with the native board headline, which is
 * exactly what the derived 7/90 boards rank on (spec §1.1-C).
 *
 * Composite payload shapes (built by the adapter, replayable from RAW):
 *   profile bundle: { info, profitInfo, gain, profit, tradeAmount,
 *                     symbolRate, timeframe }
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
  const n = num(msEpoch)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

/** "YYYY-MM-DD" settle date → UTC midnight ISO (charts are UTC-labeled). */
function dayIso(v: unknown): string | null {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  return `${v}T00:00:00.000Z`
}

function data(payload: unknown): Dict | null {
  const d = (payload as Dict)?.data
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as Dict) : null
}

function dataArray(payload: unknown): Dict[] {
  const d = (payload as Dict)?.data
  return Array.isArray(d) ? (d as Dict[]) : []
}

function rows(payload: unknown): Dict[] {
  const r = (payload as Dict)?.rows
  return Array.isArray(r) ? (r as Dict[]) : []
}

/** BTCC direction: 1 = long, 2 = short. */
function side(v: unknown): 'long' | 'short' | null {
  const n = int(v)
  if (n === 1) return 'long'
  if (n === 2) return 'short'
  return null
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/**
 * 30d board (POST /documentary/trader/page {nickName,sortType:1,pageNum,
 * pageSize}, verified 2026-06-11): {total, rows}. All rows are human lead
 * traders (no bot surface on BTCC).
 */
export function parseBtccLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const items = rows(raw)
  const out: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.traderId === undefined || item.traderId === null) continue
    // maxBackRate is the MDD in BASIS POINTS (5676 = 56.76%) → /100 for percent.
    const mddBps = num(item.maxBackRate)
    out.push({
      exchangeTraderId: String(item.traderId),
      // Positional in-page rank; re-anchored across pages by the caller.
      rank: i + 1,
      nickname: (item.nickName as string) || null,
      avatarUrlOrigin: (item.avatarPic as string) || null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: num(item.rateProfit), // already percent
      headlinePnl: num(item.totalNetProfit),
      headlineWinRate: num(item.winRate), // already percent
      // Board carries MDD (maxBackRate, bps→/100) and AUM (totalTraderAtom,
      // absolute USD) — were raw-only, so board-tier traders had no MDD/AUM.
      headlineMdd: mddBps === null ? null : mddBps / 100,
      headlineAum: num(item.totalTraderAtom),
      // followNum/limitFollow, netProfitList sparkline, supportSyms... verbatim.
      raw: item,
    })
  }
  return { rows: out, reportedTotal: int((raw as Dict)?.total) }
}

interface ProfileBundle {
  info?: unknown
  profitInfo?: unknown
  gain?: unknown
  profit?: unknown
  tradeAmount?: unknown
  symbolRate?: unknown
  timeframe?: number
}

/**
 * Profile bundle, one per TF (reportType 7/30/90 — UI labels 7D/1M/3M):
 *   info:        GET  traderHomePage/info        → identity, share rate,
 *                copier counts, register days, bio
 *   profitInfo:  GET  traderHomePage/profitInfo  → all-time headline stats
 *   gain:        POST traderHomePage/gain        → per-TF performance block
 *   profit:      POST traderHomePage/profit      → daily cumulative PnL/ROI
 *   tradeAmount: POST traderHomePage/tradeAmount → daily volume bars
 *   symbolRate:  POST traderHomePage/symbolRate  → crypto preference donut
 */
export function parseBtccProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 30) as Timeframe
  const info = data(bundle.info)
  const profitInfo = data(bundle.profitInfo)
  const gain = data(bundle.gain)
  const profitDays = dataArray(bundle.profit)
  const volumeDays = dataArray(bundle.tradeAmount)
  const symbols = dataArray(bundle.symbolRate)

  const stats: ParsedStats[] = []
  if (gain) {
    const totalTrades = int(gain.totalTradeNum)
    const winTrades = int(gain.totalWinTradeNum)
    const winRate =
      totalTrades !== null && totalTrades > 0 && winTrades !== null
        ? Math.round((winTrades / totalTrades) * 10000) / 100
        : null
    const lastDay = profitDays.length > 0 ? profitDays[profitDays.length - 1] : null

    const extras: Record<string, unknown> = {}
    if (gain.profitAndCossRate !== undefined) {
      extras.profit_loss_ratio_pct = num(gain.profitAndCossRate) // 972.93 = 9.7293:1
    }
    if (gain.totalWinAmount !== undefined) extras.total_win_amount = num(gain.totalWinAmount)
    if (gain.cumulativeNetProfit !== undefined) {
      extras.cumulative_net_profit = num(gain.cumulativeNetProfit)
    }
    if (info) {
      extras.copier_limit = int(info.limitFollow)
      extras.total_copiers_history = int(info.totalFollowNum)
      extras.register_days = int(info.registerDays)
      extras.trader_level = int(info.traderLevel)
      if (typeof info.selfInfo === 'string' && info.selfInfo) extras.bio = info.selfInfo
      if (typeof info.supportSyms === 'string' && info.supportSyms) {
        extras.supported_symbols_count = info.supportSyms.split('#').length
      }
    }
    if (profitInfo) {
      extras.all_time = {
        roi: num(profitInfo.totalProfitRate),
        pnl: num(profitInfo.totalNetProfit),
        win_rate: num(profitInfo.winRate),
      }
      // Also surface all-time ROI as a top-level registry-aliased key — the
      // nested all_time.roi is invisible to promoteExtrasMetrics. Phase A.
      // (total_pnl already covered by extras.cumulative_net_profit.)
      const totalRoi = num(profitInfo.totalProfitRate)
      if (totalRoi !== null) extras.total_roi = totalRoi
    }

    const avgHoldSecs = num(gain.avgPostionTimes)
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      // Window cumulative ROI — final point of the daily ROI series (this is
      // what the native 30d board's rateProfit equals; see header note).
      roi: lastDay ? num(lastDay.dayTotalProfitRate) : null,
      pnl: num(gain.totalNetProfit),
      sharpe: null,
      mdd: num(gain.maxBackRate), // already percent at profile level
      winRate,
      winPositions: winTrades,
      totalPositions: totalTrades,
      copierPnl: null, // not exposed per-TF
      copierCount: info ? int(info.followNum) : null,
      aum: num(gain.traderAtom),
      volume: null, // only daily bars are exposed (series volume_daily)
      profitShareRate: info ? num(info.shareProfitRate) : null,
      holdingDurationAvgHours: avgHoldSecs === null ? null : avgHoldSecs / 3600,
      tradingPreferences: symbols.length > 0 ? { symbols } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints: Array<{ ts: string; value: number }> = []
  const pnlPoints: Array<{ ts: string; value: number }> = []
  for (const day of profitDays) {
    const ts = dayIso(day.settleDate)
    if (ts === null) continue
    const roi = num(day.dayTotalProfitRate)
    if (roi !== null) roiPoints.push({ ts, value: roi })
    const pnl = num(day.dayTotalProfit)
    if (pnl !== null) pnlPoints.push({ ts, value: pnl })
  }
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })
  const volumePoints: Array<{ ts: string; value: number }> = []
  for (const day of volumeDays) {
    const ts = dayIso(day.settleDate)
    const value = num(day.dayTradeAmount)
    if (ts === null || value === null) continue
    volumePoints.push({ ts, value })
  }
  if (volumePoints.length > 0) {
    series.push({ timeframe: tf, metric: 'volume_daily', points: volumePoints })
  }

  const identity = info ?? profitInfo
  return {
    stats,
    series,
    nickname: identity ? ((identity.nickName as string) ?? null) : null,
    avatarUrlOrigin: identity ? ((identity.avatarPic as string) ?? null) : null,
  }
}

/**
 * Ongoing lead positions (POST traderHomePage/currentBringRecord): open
 * rows have closeTime=null and profit=0 (unrealized PnL is NOT public) —
 * NULL-collapse (spec §6). closeVolume is the contract qty.
 */
export function parseBtccPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const out: ParsedPosition[] = []
  for (const item of rows(raw)) {
    if (!item.tradePair) continue
    out.push({
      symbol: String(item.tradePair),
      side: side(item.direction),
      leverage: num(item.multiple),
      size: num(item.closeVolume),
      entryPrice: num(item.openPrice),
      markPrice: null,
      unrealizedPnl: null, // profit is always 0 on open rows
      raw: item,
    })
  }
  return out
}

/**
 * History (POST traderHomePage/hisotryBringRecord — endpoint typo is
 * BTCC's): closed lead positions, newest first; positionId+dealId is the
 * stable natural key. profitRate is percent.
 */
export function parseBtccPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const out: ParsedHistoryRow[] = []
  for (const item of rows(raw)) {
    if (!item.tradePair) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.openTime),
      closedAt: iso(item.closeTime),
      symbol: String(item.tradePair),
      side: side(item.direction),
      leverage: num(item.multiple),
      size: num(item.closeVolume),
      entryPrice: num(item.openPrice),
      exitPrice: num(item.closePrice),
      realizedPnl: num(item.profit),
      dedupeHash:
        item.positionId !== undefined
          ? dedupeHash('btcc_ph', item.positionId, item.dealId)
          : dedupeHash('btcc_ph', item.tradePair, item.openTime, item.closeTime, item.closeVolume),
      raw: item,
    })
  }
  return out
}

/**
 * Followers (POST traderBring/follow/page). nickName is a partially-masked
 * email — stored for dedupe/aggregates only, NEVER rendered (spec §6 PII).
 */
export function parseBtccCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const scraped = Date.parse(ctx.scrapedAt)
  const out: ParsedHistoryRow[] = []
  for (const item of rows(raw)) {
    if (item.userId === undefined || item.userId === null) continue
    const followMs = num(item.followTime)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String((item.nickName as string) || item.userId),
      copierPnl: num(item.cumulativeNetProfit),
      copierInvested: null, // not exposed
      copyDurationDays:
        followMs !== null && followMs > 0 && Number.isFinite(scraped)
          ? Math.max(0, Math.floor((scraped - followMs) / 86_400_000))
          : null,
      dedupeHash: dedupeHash('btcc_cp', item.userId, item.followTime),
      raw: item,
    })
  }
  return out
}

export function parseBtccHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseBtccPositionHistory(raw, ctx)
    case 'copiers':
      return parseBtccCopiers(raw, ctx)
    default:
      // order-level records and transfers are not exposed publicly.
      throw new Error(`[btcc] history surface ${kind} not supported`)
  }
}
