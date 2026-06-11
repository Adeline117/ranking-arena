/**
 * Bitget pure parsers (spec §11.4) — work on stored RAW payloads only.
 *
 * The public copy-trading API has two response shapes in the wild:
 *   currentTrader/list (GET): roi/winRate/drawDown already in PERCENT,
 *     ids in traderId, names in traderName, avatar in headUrl
 *   traderList (POST, legacy VPS path): ratios as DECIMALS (0.155=15.5%),
 *     ids in traderUid, names in traderNickName, avatar in headPic
 * Both are handled; raw items are kept verbatim per spec §3.
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

/** Percent-or-decimal disambiguation: decimal shape uses different keys. */
function pct(item: Dict, pctKey: string, decimalKeys: string[]): number | null {
  const direct = num(item[pctKey])
  if (direct !== null) return direct
  for (const key of decimalKeys) {
    const dec = num(item[key])
    if (dec !== null) return dec * 100
  }
  return null
}

function listOf(payload: unknown): Dict[] {
  const data = ((payload as Dict)?.data ?? {}) as Dict
  // UTA traderView puts the board in data.rows; legacy shapes use list/traderList.
  const list = data.rows ?? data.list ?? data.traderList ?? []
  return Array.isArray(list) ? (list as Dict[]) : []
}

/** UTA itemVoList → metric map: [{showColumnCode, comparedValue}, ...]. */
function utaColumns(item: Dict): Record<string, number | null> {
  const out: Record<string, number | null> = {}
  const cols = item.itemVoList
  if (Array.isArray(cols)) {
    for (const col of cols as Dict[]) {
      const code = col.showColumnCode
      if (typeof code === 'string') out[code] = num(col.comparedValue)
    }
  }
  return out
}

export function parseBitgetLeaderboardPage(
  payload: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const data = ((payload as Dict)?.data ?? {}) as Dict
  // UTA: data.totals is the PAGE row count and nextFlag drives pagination —
  // there is no global total, so reportedTotal stays null for that shape.
  const reportedTotal = data.nextFlag === undefined ? int(data.total) : null
  const items = listOf(payload)

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    // traderUid = the trader identity (UTA); portfolioId stays in raw.
    const id = item.traderUid ?? item.traderId
    if (!id) continue
    const cols = utaColumns(item)
    rows.push({
      exchangeTraderId: String(id),
      // Sort order is the rank; re-anchored across pages by the caller.
      rank: int(item.rank) ?? i + 1,
      nickname:
        (item.displayName as string) ??
        (item.traderName as string) ??
        (item.traderNickName as string) ??
        null,
      avatarUrlOrigin: (item.headPic as string) ?? (item.headUrl as string) ?? null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: cols.profit_rate ?? pct(item, 'roi', ['profitRate', 'returnRate']),
      headlinePnl: cols.total_income ?? num(item.profit ?? item.totalProfit),
      headlineWinRate: cols.winning_rate ?? pct(item, 'winRate', ['winningRate']),
      raw: item,
    })
  }
  return { rows, reportedTotal }
}

/** Kline rows shared by roiRows/pnlRows/netProfitKlineDTO: {amount, dataTime ms}. */
function klinePoints(node: unknown): Array<{ ts: string; value: number }> {
  const rows = (node as Dict)?.rows
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows as Dict[]) {
    const ts = num(row.dataTime)
    const value = num(row.amount)
    if (ts === null || value === null) continue
    points.push({ ts: new Date(ts).toISOString(), value })
  }
  return points
}

/**
 * Real profile bundle (verified by live capture 2026-06-11):
 *   detailV2:  POST /v1/trigger/trace/public/traderDetailPageV2 {traderUid}
 *              → identity, AUM, 分润比例, copier block, labels
 *   cycleData: POST /v1/trigger/trace/public/cycleData {triggerUserId, cycleTime}
 *              → statisticsDTO (per-TF 表现 block) + roiRows/pnlRows
 *                (cumulative 收益率 / 盈亏 chart series, §11.4)
 * Verified invariants: pnlRows last point == statisticsDTO.profit and
 * roiRows last point == statisticsDTO.profitRate (both already percent/quote).
 */
export function parseBitgetProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as { detailV2?: Dict; cycleData?: Dict; timeframe?: number }
  const tf = (bundle.timeframe ?? 90) as Timeframe
  const info = ((bundle.detailV2 as Dict)?.data ?? null) as Dict | null
  const cycle = ((bundle.cycleData as Dict)?.data ?? null) as Dict | null
  const st = (cycle?.statisticsDTO ?? null) as Dict | null
  const positionTime = (cycle?.positionTimeDTO ?? null) as Dict | null
  // averageHoldingTime unit is seconds (bucket boundaries / longestHoldingTime
  // only make sense as seconds for multi-day swing positions).
  const avgHoldingSecs = num(positionTime?.averageHoldingTime)

  const stats: ParsedStats[] = []
  if (st) {
    const extras: Record<string, unknown> = {}
    if (st.tradeFrequency !== undefined) extras.trade_frequency = num(st.tradeFrequency)
    if (st.largestProfit !== undefined) extras.largest_profit = num(st.largestProfit)
    if (st.largestLoss !== undefined) extras.largest_loss = num(st.largestLoss)
    if (st.longShortRatio !== undefined) extras.long_short_ratio = st.longShortRatio
    if (info) {
      if (info.settledInDays !== undefined) extras.settled_in_days = int(info.settledInDays)
      if (info.followerCount !== undefined) extras.copier_count_current = int(info.followerCount)
      if (info.maxFollowCount !== undefined) extras.copier_count_max = int(info.maxFollowCount)
      if (Array.isArray(info.labelVos)) {
        extras.style_labels = (info.labelVos as Dict[])
          .map((l) => l.name)
          .filter((n): n is string => typeof n === 'string')
      }
    }

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: num(st.profitRate), // already percent
      pnl: num(st.profit),
      sharpe: null, // Bitget does not expose Sharpe — NULL means "not exposed"
      mdd: num(st.maxRetracement), // already percent
      winRate: num(st.winningRate), // already percent
      winPositions: int(st.profitTrades),
      totalPositions: int(st.totalTrades),
      copierPnl: num(st.totalFollowProfit),
      copierCount: int(st.totalFollowers),
      aum: num(st.aum),
      volume: null,
      profitShareRate: num(st.distributeRatio), // percent (e.g. "10")
      holdingDurationAvgHours: avgHoldingSecs === null ? null : avgHoldingSecs / 3600,
      tradingPreferences: (cycle?.symbolDistributeDetail ?? null) as Dict | null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = klinePoints(cycle?.roiRows) // 收益率 curve (cumulative %)
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = klinePoints(cycle?.pnlRows) // 盈亏 toggle (cumulative quote)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })

  return {
    stats,
    series,
    nickname: info
      ? ((info.displayName as string) ?? (info.traderNickName as string) ?? null)
      : null,
    avatarUrlOrigin: info ? ((info.headPic as string) ?? null) : null,
  }
}

/** holdSide/position: 1 = long (多仓), 2 = short (空仓) — verified against
 *  positionDesc on historyList rows from the same account. */
function bitgetSide(v: unknown): 'long' | 'short' | null {
  const n = num(v)
  if (n === 1) return 'long'
  if (n === 2) return 'short'
  return null
}

/**
 * Open positions (verified by live capture 2026-06-11):
 *   POST /v1/trigger/trace/public/traderPosition {traderUid} → data: [...]
 * Works without auth even when the trader enables 未结仓位保护 (the blocked
 * order/currentList variant is the COPIER view, not this public one).
 * Bitget shows these to non-copiers with a 1h delay (spec §5.7) — the
 * caller stamps as_of = scraped_at − meta.positions_delay_hours.
 *
 * NOTE: the payload exposes margin (openMarginCount, quote units) but not
 * contract size / mark price / uPnL — those stay NULL (NULL-collapse, §6).
 */
export function parseBitgetPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const data = (raw as Dict)?.data
  if (!Array.isArray(data)) return []
  const out: ParsedPosition[] = []
  for (const item of data as Dict[]) {
    const symbol = (item.symbolDisplayName ?? item.symbolId) as string | undefined
    if (!symbol) continue
    out.push({
      symbol: String(symbol),
      side: bitgetSide(item.holdSide ?? item.position),
      leverage: num(item.openLevel),
      // size = position margin in quote units (openMarginCount); Bitget does
      // not expose base-asset quantity on this endpoint.
      size: num(item.openMarginCount),
      entryPrice: num(item.avgPrice ?? item.openAvgPrice),
      markPrice: null,
      unrealizedPnl: null,
      raw: item,
    })
  }
  return out
}

// ── Histories (spec §2.3 incremental) ──

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

/**
 * 历史带单 rows (POST /v1/trigger/trace/order/historyList, captured
 * 2026-06-11): orderNo is the stable natural key; openTime/closeTime are ms
 * epochs; netProfit = realized PnL after fees (achievedProfits = before).
 */
export function parseBitgetPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const rows = ((raw as Dict)?.data as Dict)?.rows
  if (!Array.isArray(rows)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of rows as Dict[]) {
    const symbol = (item.symbolDisplayName ?? item.productCode ?? item.symbolId) as
      | string
      | undefined
    if (!symbol) continue
    const openedAt = num(item.openTime)
    const closedAt = num(item.closeTime)
    out.push({
      kind: 'position_history',
      openedAt: openedAt === null ? null : new Date(openedAt).toISOString(),
      closedAt: closedAt === null ? null : new Date(closedAt).toISOString(),
      symbol: String(symbol),
      side: bitgetSide(item.position ?? item.holdSide),
      leverage: num(item.openLevel),
      size: num(item.closeDealCount ?? item.openDealCount), // base-asset quantity
      entryPrice: num(item.openAvgPrice),
      exitPrice: num(item.closeAvgPrice),
      realizedPnl: num(item.netProfit ?? item.achievedProfits),
      dedupeHash: item.orderNo
        ? dedupeHash('bitget_ph', item.orderNo)
        : dedupeHash('bitget_ph', symbol, item.openTime, item.closeTime, item.closeDealCount),
      raw: item,
    })
  }
  return out
}

/**
 * 跟单者 rows (POST /v1/trigger/trace/trader/followerList, captured
 * 2026-06-11): totalMargin = 累计投资额, totalProfit = 跟单者收益. The API
 * exposes no last-updated timestamp (the UI label is client-side), so ts =
 * ctx.scrapedAt. copierLabel is stored for dedupe only — NEVER rendered.
 */
export function parseBitgetCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const rows = ((raw as Dict)?.data as Dict)?.rows
  if (!Array.isArray(rows)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of rows as Dict[]) {
    const label = (item.userName ?? item.displayName ?? item.followerNickName) as string | undefined
    if (!label) continue
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: String(label),
      copierPnl: num(item.totalProfit),
      copierInvested: num(item.totalMargin),
      copyDurationDays: null, // not exposed by this endpoint
      dedupeHash: dedupeHash('bitget_cp', label, item.totalProfit, item.totalMargin),
      raw: item,
    })
  }
  return out
}

export function parseBitgetHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseBitgetPositionHistory(raw, ctx)
    case 'copiers':
      return parseBitgetCopiers(raw, ctx)
    default:
      // orders: no public endpoint; transfers: 余额历史 removed from the UTA
      // UI and all candidates are auth-gated (verified 2026-06-11).
      throw new Error(`[bitget] history surface ${kind} not supported`)
  }
}
