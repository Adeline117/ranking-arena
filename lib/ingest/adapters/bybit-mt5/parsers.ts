/**
 * Bybit MT5 (copyMt5, "Copy Trading TradFi") pure parsers — spec §11.2.
 * Work on stored RAW payloads only; unit is USDx (CFD margin currency),
 * which flows from sources.currency — values are NEVER converted to USDT
 * (spec §5.8 Money discipline).
 *
 * Number encoding (verified by live capture 2026-06-11): every numeric is a
 * STRING with an `E{n}` suffix on the key meaning value × 10^-n:
 *   roeE4 "37181"        → 3.7181  (fraction)  → 371.81 %
 *   winRateE4 "4459"     → 0.4459               → 44.59 %
 *   masterPnlE8 "59583000000" → 595.83 USDx
 *   sharpeRatioE4 "2195" → 0.2195  (raw ratio)
 *   avgHoldingTimeE3 "1488351" → 1488.351 seconds
 *   statisticDateE3      → ms epoch
 * History timestamps are server-rendered "YYYY-MM-DD HH:mm:ss" strings in
 * UTC (session UTC-pinned; verified against capture wall-clock).
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

/** Decode an `E{n}` suffixed string: value × 10^-scale. */
function e(v: unknown, scale: number): number | null {
  const n = num(v)
  return n === null ? null : n / 10 ** scale
}

/** E4 fraction → percent (37181 → 371.81). */
function pctE4(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n / 100
}

function result(payload: unknown): Dict {
  return ((payload as Dict)?.result ?? {}) as Dict
}

/**
 * All-traders board (verified 2026-06-11):
 *   GET /x-api/fapi/copymt5/public/v1/common/dynamic-provider-list
 *       ?pageNo&pageSize=16&dataDuration=DATA_DURATION_{SEVEN|THIRTY|NINETY}_DAY
 *       &providerTag=&countryCode=
 * Empty providerTag = the full 全部交易达人 board (totalCount ~29.5k);
 * named tags (PROVIDER_TAG_COMPOSITE_LIST etc.) are preset boards — ignored
 * per spec §11.3 convention. providerMark (opaque base64) is the stable
 * public trader id used by every profile endpoint.
 */
export function parseBybitMt5LeaderboardPage(
  payload: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const res = result(payload)
  const reportedTotal = int(res.totalCount)
  const items = Array.isArray(res.providerDetailsList) ? (res.providerDetailsList as Dict[]) : []

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.providerMark
    if (!id) continue
    // Master Trader Rank (Cadet/Bronze/Silver/Gold...) — spec §11.2 says
    // scrape trader segmentation; durable, so it goes on traders.meta.
    const traderMeta: Record<string, unknown> = {}
    if (typeof item.providerLevel === 'string') traderMeta.provider_level = item.providerLevel
    rows.push({
      exchangeTraderId: String(id),
      // Positional in-page rank; re-anchored across pages by the caller.
      rank: i + 1,
      nickname: (item.nickName as string) ?? null,
      avatarUrlOrigin: (item.profilePhoto as string) ?? null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pctE4(item.roeE4),
      headlinePnl: e(item.masterPnlE8, 8),
      headlineWinRate: pctE4(item.winRateE4),
      traderMeta: Object.keys(traderMeta).length > 0 ? traderMeta : null,
      raw: item,
    })
  }
  return { rows, reportedTotal }
}

/** income-detail field prefix per canonical timeframe. */
const TF_PREFIX: Record<7 | 30 | 90, string> = {
  7: 'sevenDay',
  30: 'thirtyDay',
  90: 'ninetyDay',
}

/** yield-trend metricLineValue → series points ({statisticDateE3, value}). */
function trendPoints(
  metric: Dict | undefined,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  const rows = metric?.metricLineValue
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows as Dict[]) {
    const ts = num(row.statisticDateE3)
    const value = decode(row.value)
    if (ts === null || value === null) continue
    points.push({ ts: new Date(ts).toISOString(), value })
  }
  return points
}

/**
 * Profile bundle (one per TF, mirroring the Bitget shape):
 *   info:         GET pub-provider/info?providerMark=          (identity, TF-free)
 *   incomeDetail: GET common/provider-income-detail?providerMark=
 *                 → the WHOLE §11.2 表现 block for all 3 TFs in one response
 *                   ({seven|thirty|ninety}Day-prefixed fields), incl. Sharpe
 *                   AND Sortino — Bybit exposes both, map them!
 *   yieldTrend:   GET provider/dynamic-yield-trend?dayCycleType=...&period=PERIOD_DAY
 *                 → 统计数据 获利 chart: cumRoe + cumProfit dual + dailyRoe
 * parseProfile extracts ONLY the requested timeframe's stats block.
 */
export function parseBybitMt5Profile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as {
    info?: Dict
    incomeDetail?: Dict
    yieldTrend?: Dict
    timeframe?: number
  }
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 90) as 7 | 30 | 90
  const info = result(bundle.info)
  const inc = result(bundle.incomeDetail)
  const p = TF_PREFIX[tf]

  const stats: ParsedStats[] = []
  if (Object.keys(inc).length > 0) {
    const winCount = int(inc[`${p}CumWinCount`])
    const lossCount = int(inc[`${p}CumLossCount`])
    const holdingSecs = e(inc[`${p}AvgHoldingTimeE3`], 3)

    const extras: Record<string, unknown> = {}
    const sortino = e(inc[`${p}SortinoRatioE4`], 4)
    if (sortino !== null) extras.sortino = sortino
    const p2l = e(inc[`${p}ProfitToLossRatioE2`], 2)
    if (p2l !== null) extras.profit_to_loss_ratio = p2l
    const weeklyTrades = e(inc[`${p}WeeklyTradesE2`], 2)
    if (weeklyTrades !== null) extras.weekly_trades = weeklyTrades
    const avgPnlPerTrade = e(inc[`${p}AvgPnlPerTradeE8`], 8)
    if (avgPnlPerTrade !== null) extras.avg_pnl_per_trade = avgPnlPerTrade
    const roeVolatility = pctE4(inc[`${p}RoeVolatilityE4`])
    if (roeVolatility !== null) extras.roe_volatility = roeVolatility
    const lastTraded = num(inc.lastTradedAtTimeE3)
    if (lastTraded !== null && lastTraded > 0) {
      extras.last_traded_at = new Date(lastTraded).toISOString()
    }
    if (info.tradingDays !== undefined) extras.trading_days = int(info.tradingDays)
    if (info.providerUserId !== undefined) extras.provider_user_id = String(info.providerUserId)
    const totalAssets = e(info.totalAssetsE8, 8)
    if (totalAssets !== null) extras.total_assets = totalAssets
    // P1: loss count (the win count already lands as winPositions), margin
    // level, and the max-copier cap — all present in the income/info payloads.
    if (lossCount !== null) extras.loss_trades = lossCount
    const marginLevel = e(info.marginLevelE4, 4)
    if (marginLevel !== null) extras.margin_level = marginLevel
    if (info.followMaxUpperLimit !== undefined)
      extras.copier_count_max = int(info.followMaxUpperLimit)

    stats.push({
      timeframe: tf as Timeframe,
      asOf: ctx.scrapedAt,
      roi: pctE4(inc[`${p}RoeE4`]),
      pnl: e(inc[`${p}MasterPnlE8`], 8),
      sharpe: e(inc[`${p}SharpeRatioE4`], 4),
      mdd: pctE4(inc[`${p}MaxDrawdownE4`]),
      winRate: pctE4(inc[`${p}WinRateE4`]),
      winPositions: winCount,
      totalPositions:
        winCount === null && lossCount === null ? null : (winCount ?? 0) + (lossCount ?? 0),
      copierPnl: e(inc[`${p}FollowersPnlE8`], 8),
      copierCount: int(info.followers),
      aum: e(info.aumE8, 8),
      volume: null,
      // shareProfitRateE2 "15" → 0.15 fraction → 15 % (stored as percent,
      // matching the Bitget convention).
      profitShareRate: num(info.shareProfitRateE2),
      holdingDurationAvgHours: holdingSecs === null ? null : holdingSecs / 3600,
      tradingPreferences: null,
      extras,
    })
  }

  const metrics = new Map<string, Dict>()
  const list = result(bundle.yieldTrend).metricList
  if (Array.isArray(list)) {
    for (const m of list as Dict[]) {
      if (typeof m.line === 'string') metrics.set(m.line, m)
    }
  }
  const series: ParsedProfile['series'] = []
  const roiPoints = trendPoints(metrics.get('cumRoe'), pctE4) // 累计收益率 (%)
  if (roiPoints.length > 0)
    series.push({ timeframe: tf as Timeframe, metric: 'roi', points: roiPoints })
  const pnlPoints = trendPoints(metrics.get('cumProfit'), (v) => e(v, 8)) // 累计收益额 (USDx)
  if (pnlPoints.length > 0)
    series.push({ timeframe: tf as Timeframe, metric: 'pnl', points: pnlPoints })
  const dailyRoiPoints = trendPoints(metrics.get('dailyRoe'), pctE4)
  if (dailyRoiPoints.length > 0) {
    series.push({ timeframe: tf as Timeframe, metric: 'roi_daily', points: dailyRoiPoints })
  }

  return {
    stats,
    series,
    nickname: (info.providerUserName as string) ?? null,
    avatarUrlOrigin: (info.providerUserAvatar as string) ?? null,
  }
}

function mt5Side(v: unknown): 'long' | 'short' | null {
  if (v === 'Buy') return 'long'
  if (v === 'Sell') return 'short'
  return null
}

/**
 * 当前开仓 (GET provider/open-position?providerMark=, verified 2026-06-11):
 * symbol/side/positionValueE8/entryPrice/marketPrice/stopLoss/takeProfit/
 * profitE8. MT5 CFD exposes position VALUE (quote USDx), not lots/leverage —
 * those stay NULL (NULL-collapse, spec §6). TP/SL kept in raw.
 */
export function parseBybitMt5Positions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const list = result(raw).openPositionList
  if (!Array.isArray(list)) return []
  const out: ParsedPosition[] = []
  for (const item of list as Dict[]) {
    if (!item.symbol) continue
    out.push({
      symbol: String(item.symbol),
      side: mt5Side(item.side),
      leverage: null,
      size: e(item.positionValueE8, 8), // position value in USDx
      entryPrice: num(item.entryPrice),
      markPrice: num(item.marketPrice),
      unrealizedPnl: e(item.profitE8, 8),
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

/** "YYYY-MM-DD HH:mm:ss" (server-rendered, UTC) → ISO string. */
function utcStamp(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const ms = Date.parse(v.replace(' ', 'T') + 'Z')
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * 平仓仓位 (GET provider/get-history-position?providerMark=&pageSize=10,
 * verified 2026-06-11). No position id exposed → dedupe hash over the full
 * natural tuple. PUBLIC DEPTH LIMIT: the endpoint returns only the newest
 * 10 rows; the response `cursor` jumps to the OLDEST page and then loops
 * (pageSize/limit ignored) — so each crawl captures the newest page and
 * coverage accumulates across crawls.
 */
export function parseBybitMt5PositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const list = result(raw).historyPositionList
  if (!Array.isArray(list)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of list as Dict[]) {
    if (!item.symbol) continue
    out.push({
      kind: 'position_history',
      openedAt: utcStamp(item.openTime),
      closedAt: utcStamp(item.closeTime),
      symbol: String(item.symbol),
      side: mt5Side(item.side),
      leverage: null,
      size: e(item.positionValueE8, 8), // position value in USDx
      entryPrice: num(item.entryPrice),
      exitPrice: num(item.closingPrice),
      realizedPnl: e(item.closedProfitE8, 8),
      dedupeHash: dedupeHash(
        'bybitmt5_ph',
        item.symbol,
        item.openTime,
        item.closeTime,
        item.positionValueE8,
        item.closedProfitE8
      ),
      raw: item,
    })
  }
  return out
}

export function parseBybitMt5History(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  if (kind !== 'position_history') {
    // orders/transfers: not exposed publicly; copiers: provider/follower-list
    // is PRIVATE (auth-gated) on MT5 — verified 2026-06-11.
    throw new Error(`[bybit-mt5] history surface ${kind} not supported`)
  }
  return parseBybitMt5PositionHistory(raw, ctx)
}
