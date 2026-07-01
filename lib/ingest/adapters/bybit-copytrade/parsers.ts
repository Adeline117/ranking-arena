/**
 * Bybit copyTrade classic ("beehive") pure parsers — spec §11.3.
 * Work on stored RAW payloads only; unit is USDT (sources.currency).
 *
 * Number encoding (verified by live capture 2026-06-11, cross-checked
 * against the rendered profile UI):
 *   sevenDayYieldRateE4 "-1945"   → -19.45 %   (E4 fraction → percent)
 *   sevenDayProfitE8 "-21472556189" → -214.73 USDT
 *   sevenDaySharpeRatioE4 "-24707"  → -2.4707 (raw ratio)
 *   sevenDayAvePositionTime "13198" → MINUTES (13198 min = 9.16 days ✓ UI)
 *   shareProfitRateE8 "10000000"    → 0.10 fraction → 10 %
 *   recentTradeTimeE3               → ms epoch
 *
 * Board rows expose metrics as DISPLAY STRINGS ("+11.36%", "+30,564.63",
 * "45.49 : 0") in `metricValues`, aligned positionally with the page-level
 * `metricColumns` (keyed by sortKey). parseLeaderboard resolves that
 * alignment and stores a derived `_metrics` map inside `raw` so entries.raw
 * stays self-describing without the page context.
 *
 * Bot scope (spec §1.3 / §11.3 #3): dynamic-yield-trend returns all three
 * scopes in ONE response — metricListAll (全部), metricList (交易),
 * metricListBot (机器人). Base metrics come from 全部; `_trading`/`_bot`
 * variants are emitted only when the bot scope carries signal (any non-zero
 * point) — for the vast majority of traders the bot lists are all-zero and
 * trading == all, so emitting variants would triple series storage with no
 * information.
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

/** E4 fraction → percent (-1945 → -19.45). */
function pctE4(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n / 100
}

/** Display string → number: "+30,564.63" → 30564.63, "0.00%" → 0. */
function displayNum(v: unknown): number | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const n = Number(v.replace(/[+,%\s‎]/g, ''))
  return Number.isFinite(n) ? n : null
}

function result(payload: unknown): Dict {
  return ((payload as Dict)?.result ?? {}) as Dict
}

/** metricColumns sortKey → canonical key for the derived `_metrics` map. */
const SORT_KEY_METRIC: Record<string, string> = {
  LEADER_SORT_FIELD_SORT_ROI: 'roi',
  LEADER_SORT_FIELD_SORT_DRAW_DOWN: 'drawdown',
  LEADER_SORT_FIELD_SORT_FOLLOWERS_YIELD: 'follower_pnl',
  LEADER_SORT_FIELD_SORT_WIN_RATE: 'win_rate',
  LEADER_SORT_FIELD_SORT_YIELD_LOSS_RATIO: 'profit_loss_ratio',
  LEADER_SORT_FIELD_SORT_SHARPE_RATIO: 'sharpe',
}

/**
 * 全部交易达人 board (verified 2026-06-11):
 *   GET /x-api/fapi/beehive/public/v1/common/dynamic-leader-list
 *       ?pageNo&pageSize=16&userTag=&dataDuration=DATA_DURATION_{SEVEN|THIRTY|NINETY}_DAY
 *       &leaderTag=&code=&leaderLevel=
 * Empty leaderTag = the full all-traders board (totalCount ~8.8k); named
 * tags (LEADER_TAG_COMPOSITE_LIST 均衡 / LEADER_TAG_TOP_PERFORMING 最高ROI
 * etc.) are the preset boards — ignored per spec §11.3. leaderMark (opaque
 * base64) is the stable public trader id used by every profile endpoint.
 *
 * Board columns are display strings (see module docs). There is no master
 * PnL column → headlinePnl stays NULL (profile stats provide pnl).
 */
/** Board-row copier PnL / max-slots / P-L ratio → extras (逐图核对). */
function ctBoardExtras(
  item: Dict,
  metrics: Record<string, unknown>
): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const copierPnl = num(metrics.follower_pnl)
  if (copierPnl !== null) ext.copier_total_profit = copierPnl
  const maxSlots = int(item.maxFollowerCount)
  if (maxSlots !== null) ext.max_copier_slots = maxSlots
  // "45.49 : 0" win:loss ratio string → numeric (skip when denominator is 0).
  const plr = metrics.profit_loss_ratio
  if (typeof plr === 'string' && plr.includes(':')) {
    const [a, b] = plr.split(':').map((x) => Number(x.trim()))
    if (Number.isFinite(a) && Number.isFinite(b) && b > 0) {
      ext.profit_to_loss_ratio = Math.round((a / b) * 100) / 100
    }
  }
  return Object.keys(ext).length > 0 ? ext : null
}

export function parseBybitCopytradeLeaderboardPage(
  payload: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const res = result(payload)
  const reportedTotal = int(res.totalCount)
  const items = Array.isArray(res.leaderDetails) ? (res.leaderDetails as Dict[]) : []
  const columns = Array.isArray(res.metricColumns) ? (res.metricColumns as Dict[]) : []
  const columnKeys = columns.map((c) => SORT_KEY_METRIC[String(c.sortKey)] ?? String(c.colName))

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.leaderMark
    if (!id) continue

    // Positional display values → named map (kept inside raw; the ratio
    // column ("45.49 : 0") stays a string, the rest parse to numbers).
    const metricValues = Array.isArray(item.metricValues) ? (item.metricValues as unknown[]) : []
    const metrics: Record<string, unknown> = {}
    for (let c = 0; c < columnKeys.length && c < metricValues.length; c++) {
      const raw = metricValues[c]
      metrics[columnKeys[c]] =
        columnKeys[c] === 'profit_loss_ratio' ? raw : (displayNum(raw) ?? raw)
    }

    // Durable badge/level/country metadata (spec §11.3) → traders.meta.
    const traderMeta: Record<string, unknown> = {}
    if (typeof item.leaderLevel === 'string') traderMeta.leader_level = item.leaderLevel
    if (typeof item.countryCode === 'string' && item.countryCode !== '') {
      traderMeta.country_code = item.countryCode
    }
    if (item.leaderUserId !== undefined) traderMeta.leader_user_id = String(item.leaderUserId)
    const tags = Array.isArray(item.userTag)
      ? (item.userTag as Dict[]).map((t) => t.title).filter((t) => typeof t === 'string')
      : []
    if (tags.length > 0) traderMeta.user_tags = tags

    rows.push({
      exchangeTraderId: String(id),
      // Positional in-page rank; re-anchored across pages by the caller.
      rank: i + 1,
      nickname: (item.nickName as string) ?? null,
      avatarUrlOrigin: (item.profilePhoto as string) ?? null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: num(metrics.roi),
      headlinePnl: null,
      headlineWinRate: num(metrics.win_rate),
      // The board has a Drawdown column (SORT_KEY..DRAW_DOWN -> 'drawdown'); its
      // display value is already a percent like roi/win_rate, so num() not pct().
      // Was unread → bybit-copytrade sat at ~9% MDD capture (top-N profiles only).
      headlineMdd: num(metrics.drawdown),
      // 逐图核对 image17: board also carries Sharpe + copier count + follower PnL +
      // P/L ratio (in metricValues / item) — were raw._metrics only, so board-tier
      // traders lacked them. Promote (profile has them typed for crawled traders).
      headlineSharpe: num(metrics.sharpe),
      headlineCopierCount: int(item.currentFollowerCount),
      headlineExtras: ctBoardExtras(item, metrics),
      traderMeta: Object.keys(traderMeta).length > 0 ? traderMeta : null,
      raw: { ...item, _metrics: metrics },
    })
  }
  return { rows, reportedTotal }
}

/** leader-income field prefix per canonical timeframe. */
const TF_PREFIX: Record<7 | 30 | 90, string> = {
  7: 'sevenDay',
  30: 'thirtyDay',
  90: 'ninetyDay',
}

/** dynamic-yield-trend chart line → canonical series metric. */
const TREND_LINES: ReadonlyArray<{
  line: string
  metric: string
  decode: (v: unknown) => number | null
}> = [
  { line: 'cumResetRoi', metric: 'roi', decode: pctE4 }, // 累计收益率 (%)
  { line: 'cumResetPnl', metric: 'pnl', decode: (v) => e(v, 8) }, // 累计收益额 (USDT)
  { line: 'yieldRate', metric: 'roi_daily', decode: pctE4 }, // 收益额 daily bar
]

function trendPoints(
  metric: Dict | undefined,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  const rows = metric?.metricLineValue
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows as Dict[]) {
    const ts = num(row.statisticDate)
    const value = decode(row.value)
    if (ts === null || value === null) continue
    points.push({ ts: new Date(ts).toISOString(), value })
  }
  return points
}

function lineMap(list: unknown): Map<string, Dict> {
  const map = new Map<string, Dict>()
  if (Array.isArray(list)) {
    for (const m of list as Dict[]) {
      if (typeof m.line === 'string') map.set(m.line, m)
    }
  }
  return map
}

/** Any non-zero point anywhere in a scope's lines = the scope has signal. */
function hasSignal(list: unknown): boolean {
  if (!Array.isArray(list)) return false
  return (list as Dict[]).some((m) => {
    const rows = m.metricLineValue
    return (
      Array.isArray(rows) &&
      (rows as Dict[]).some((p) => p.value !== '0' && p.value !== '' && p.value !== undefined)
    )
  })
}

/**
 * Profile bundle (one per TF, mirroring the bybit-mt5 shape):
 *   info:   GET private/v1/pub-leader/info?leaderMark=
 *           (identity + profit share + AUM; "private" path but anonymous-
 *           accessible — verified 2026-06-11)
 *   income: GET public/v1/common/leader-income?leaderMark=
 *           → the WHOLE §11.3 表现 block for all 3 TFs in one response
 *             ({seven|thirty|ninety}Day-prefixed), incl. Sharpe AND Sortino
 *   yieldTrend: GET public/v2/leader/dynamic-yield-trend
 *           ?dayCycleType=DAY_CYCLE_TYPE_{...}&period=PERIOD_DAY&leaderMark=
 *           → 统计数据 charts with the 全部/交易/机器人 scope split
 *             (metricListAll / metricList / metricListBot)
 * parseProfile extracts ONLY the requested timeframe's stats block.
 */
export function parseBybitCopytradeProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as {
    info?: Dict
    income?: Dict
    yieldTrend?: Dict
    timeframe?: number
  }
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 90) as 7 | 30 | 90
  const info = result(bundle.info)
  const inc = result(bundle.income)
  const p = TF_PREFIX[tf]

  const stats: ParsedStats[] = []
  if (Object.keys(inc).length > 0) {
    const winCount = int(inc[`${p}WinCount`])
    const lossCount = int(inc[`${p}LossCount`])
    const holdingMinutes = num(inc[`${p}AvePositionTime`]) // MINUTES (verified vs UI)

    const extras: Record<string, unknown> = {}
    const sortino = e(inc[`${p}SortinoRatioE4`], 4)
    if (sortino !== null) extras.sortino = sortino
    const p2l = e(inc[`${p}YieldLossRatioE4`], 4)
    if (p2l !== null) extras.profit_to_loss_ratio = p2l
    const weeklyTrades = e(inc[`${p}WeekTradeCountE2`], 2)
    if (weeklyTrades !== null) extras.weekly_trades = weeklyTrades
    const avgPnlPerTrade = e(inc[`${p}AvgYieldLossE8`], 8)
    if (avgPnlPerTrade !== null) extras.avg_pnl_per_trade = avgPnlPerTrade
    const roeVolatility = pctE4(inc[`${p}ReturnVolatilityE4`])
    if (roeVolatility !== null) extras.roe_volatility = roeVolatility
    const lastTraded = num(inc.recentTradeTimeE3)
    if (lastTraded !== null && lastTraded > 0) {
      extras.last_traded_at = new Date(lastTraded).toISOString()
    }
    const stability = e(info.stableScoreLevelE1 ?? inc.stableScoreLevelE1, 1)
    if (stability !== null) extras.stability_score = stability // x/5.0 UI scale
    if (info.tradeDays !== undefined) extras.trading_days = int(info.tradeDays)
    if (info.leaderUserId !== undefined) extras.leader_user_id = String(info.leaderUserId)
    const cumFollowers = int(info.cumFollowerCount)
    if (cumFollowers !== null) extras.cum_follower_count = cumFollowers
    const maxFollowers = int(info.maxFollowerCount)
    if (maxFollowers !== null) extras.max_follower_count = maxFollowers
    if (typeof info.leaderUserIntroduction === 'string' && info.leaderUserIntroduction !== '') {
      extras.bio = info.leaderUserIntroduction
    }
    // P1: per-period loss count (winCount already lands as winPositions) +
    // wallet (margin) balance — both present in the payload.
    if (lossCount !== null) extras.loss_trades = lossCount
    const walletBalance = e(info.walletBalanceE8, 8)
    if (walletBalance !== null) extras.wallet_balance = walletBalance
    // Lifetime (cumulative, TF-independent) leader stats (Phase A: were raw-only).
    const totalRoi = pctE4(inc.cumYieldRateE4) // 累计收益率 %
    if (totalRoi !== null) extras.total_roi = totalRoi
    const totalPnl = e(inc.cumYieldE8, 8) // 累计收益额
    if (totalPnl !== null) extras.total_pnl = totalPnl
    const lifetimeTrades = int(inc.cumTradeCount)
    if (lifetimeTrades !== null) extras.lifetime_trades = lifetimeTrades

    stats.push({
      timeframe: tf as Timeframe,
      asOf: ctx.scrapedAt,
      roi: pctE4(inc[`${p}YieldRateE4`]),
      pnl: e(inc[`${p}ProfitE8`], 8),
      sharpe: e(inc[`${p}SharpeRatioE4`], 4),
      mdd: pctE4(inc[`${p}DrawDownE4`]),
      winRate: pctE4(inc[`${p}ProfitWinRateE4`]),
      winPositions: winCount,
      totalPositions:
        winCount === null && lossCount === null ? null : (winCount ?? 0) + (lossCount ?? 0),
      copierPnl: e(inc[`${p}FollowerYieldE8`], 8),
      copierCount: int(info.currentFollowerCount ?? inc.currentFollowerCount),
      aum: e(info.aumE8 ?? inc.aumE8, 8),
      volume: null,
      // shareProfitRateE8 "10000000" → 0.10 fraction → 10 % (stored as
      // percent, matching the Bitget/MT5 convention).
      profitShareRate: (() => {
        const f = e(info.shareProfitRateE8, 8)
        return f === null ? null : f * 100
      })(),
      holdingDurationAvgHours: holdingMinutes === null ? null : holdingMinutes / 60,
      tradingPreferences: null,
      extras,
    })
  }

  // 统计数据 charts — scope split (see module docs for the emit rule).
  const trend = result(bundle.yieldTrend)
  const allLines = lineMap(trend.metricListAll ?? trend.metricList)
  const series: ParsedProfile['series'] = []
  for (const { line, metric, decode } of TREND_LINES) {
    const points = trendPoints(allLines.get(line), decode)
    if (points.length > 0) series.push({ timeframe: tf as Timeframe, metric, points })
  }
  if (hasSignal(trend.metricListBot)) {
    const scoped: Array<[string, Map<string, Dict>]> = [
      ['_trading', lineMap(trend.metricList)],
      ['_bot', lineMap(trend.metricListBot)],
    ]
    for (const [suffix, lines] of scoped) {
      for (const { line, metric, decode } of TREND_LINES) {
        const points = trendPoints(lines.get(line), decode)
        if (points.length > 0) {
          series.push({ timeframe: tf as Timeframe, metric: `${metric}${suffix}`, points })
        }
      }
    }
  }

  return {
    stats,
    series,
    nickname: (info.leaderUserName as string) ?? null,
    avatarUrlOrigin: (info.leaderUserAvatar as string) ?? null,
  }
}

function beehiveSide(v: unknown): 'long' | 'short' | null {
  if (v === 'Buy') return 'long'
  if (v === 'Sell') return 'short'
  return null
}

/**
 * 当前开仓 (GET public/v1/common/position/list?leaderMark=, verified
 * 2026-06-11): symbol/side/leverageE2/sizeX(E8 base qty)/entryPrice.
 * The payload has NO mark price / uPnL (the UI computes them client-side
 * from live tickers) — those stay NULL (NULL-collapse, spec §6).
 * Traders with 未结仓位保护 return data:[] + openTradeInfoProtection=1.
 */
export function parseBybitCopytradePositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const list = result(raw).data
  if (!Array.isArray(list)) return []
  const out: ParsedPosition[] = []
  for (const item of list as Dict[]) {
    if (!item.symbol) continue
    out.push({
      symbol: String(item.symbol),
      side: beehiveSide(item.side),
      leverage: e(item.leverageE2, 2),
      size: e(item.sizeX, 8), // base-asset quantity (11442 POL ✓ UI)
      entryPrice: num(item.entryPrice),
      markPrice: null,
      unrealizedPnl: null,
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
 * Past Trader-Initiated Trades (GET public/v1/common/leader-history
 * ?leaderMark=&pageAction=first_page&pageSize=50, verified 2026-06-11).
 * PUBLIC DEPTH LIMIT: anonymous sessions get only the newest ≤50 rows
 * (pageSize caps at 50); pageAction=next_page&cursor=... returns the SAME
 * page with an empty cursor — pagination is auth-gated. Each crawl captures
 * the newest page; coverage accumulates across crawls via the dedupe-hash
 * upserts (orderId is a stable natural key).
 */
export function parseBybitCopytradePositionHistory(
  raw: unknown,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  const list = result(raw).data
  if (!Array.isArray(list)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of list as Dict[]) {
    if (!item.symbol || !item.orderId) continue
    const opened = num(item.startedTimeE3)
    const closed = num(item.closedTimeE3)
    out.push({
      kind: 'position_history',
      openedAt: opened !== null && opened > 0 ? new Date(opened).toISOString() : null,
      closedAt: closed !== null && closed > 0 ? new Date(closed).toISOString() : null,
      symbol: String(item.symbol),
      side: beehiveSide(item.side),
      leverage: e(item.leverageE2, 2),
      size: num(item.size), // base-asset quantity (plain string)
      entryPrice: num(item.entryPrice),
      exitPrice: num(item.closedPrice),
      realizedPnl: e(item.orderNetProfitE8, 8),
      dedupeHash: dedupeHash('bybitct_ph', item.orderId),
      raw: item,
    })
  }
  return out
}

/**
 * 跟单用户 (GET public/v1/common/other-follower?hasOneself=true&leaderMark=
 * &pageAction=first_page&pageSize=50). Same public depth limit as
 * leader-history (newest/top ≤50, cursor auth-gated). Copier labels are
 * pre-masked by Bybit ("gus**@***") — stored for dedupe only, NEVER
 * rendered (spec §6 PII).
 */
export function parseBybitCopytradeCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const list = result(raw).data
  if (!Array.isArray(list)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of list as Dict[]) {
    const label = item.nickName
    if (typeof label !== 'string' || label === '') continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: e(item.cumYieldE8, 8),
      copierInvested: e(item.cumFollowCostE8, 8),
      copyDurationDays: int(item.cumFollowDays),
      dedupeHash: dedupeHash('bybitct_cp', label, item.cumFollowCostE8, item.cumFollowDays),
      raw: item,
    })
  }
  return out
}

export function parseBybitCopytradeHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseBybitCopytradePositionHistory(raw, ctx)
    case 'copiers':
      return parseBybitCopytradeCopiers(raw, ctx)
    default:
      // orders/transfers: not exposed publicly. The 机器人带单数据 (bot
      // lead data) tab endpoint is still UNDISCOVERED — no bot-running
      // trader existed in the top-48 board sample on 2026-06-11; the bot
      // SCOPE series are covered via dynamic-yield-trend regardless.
      throw new Error(`[bybit-copytrade] history surface ${kind} not supported`)
  }
}
