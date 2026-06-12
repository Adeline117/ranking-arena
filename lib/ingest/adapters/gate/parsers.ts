/**
 * Gate pure parsers (spec §11.10 futures / §11.11 CFD) — work on stored RAW
 * payloads only (re-parse guarantee, spec §5.5).
 *
 * Two endpoint families share one adapter, selected by src.meta.boardKey:
 *   futures: /apiw/v2/copy/leader/* + /api/copytrade/copy_trading/trader/*
 *     — TF tokens cycle=seven|month|threemonth, rates are DECIMALS
 *       (0.5736 = 57.36%), trader/detail/{id} carries ALL per-TF stat
 *       blocks (seven_profit / month_profit / three_month_profit) in one
 *       response plus 数据更新时间 (update_time) and 最近强制平仓时间
 *       (liquidation_time) on the all-time block.
 *   cfd (tradfi): /apiw/v2/copy_tradfi/leader/* — NUMERIC cycle=7|30|90,
 *     rates are decimals too; currency is USDx (sources row; never coerce).
 *
 * Verified by live capture 2026-06-11 (gate-*-debug scripts, deleted).
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
  SeriesPoint,
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

/** Gate rates are decimal fractions (0.5736 = 57.36%). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

/** Gate timestamps are epoch SECONDS. */
function isoSecs(v: unknown): string | null {
  const n = num(v)
  return n === null || n <= 0 ? null : new Date(n * 1000).toISOString()
}

export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

// ── Leaderboard ──

/**
 * Futures list: GET /apiw/v2/copy/leader/list?...&full_ranking=1&cycle={tok}
 *   → data.{list, totalcount, pagecount}
 * CFD list:     GET /apiw/v2/copy_tradfi/leader/list?...&cycle={7|30|90}
 *   → data.{lists, totalcount, pagecount}
 * Row shapes are near-identical; user_info carries identity.
 */
export function parseGateLeaderboardPage(payload: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const data = ((payload as Dict)?.data ?? {}) as Dict
  const items = (data.list ?? data.lists ?? []) as Dict[]
  const reportedTotal = int(data.totalcount)

  const rows: ParsedLeaderboardRow[] = []
  if (!Array.isArray(items)) return { rows, reportedTotal }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.leader_id
    if (id === null || id === undefined) continue
    const user = (item.user_info ?? {}) as Dict
    rows.push({
      exchangeTraderId: String(id),
      rank: i + 1, // sorted list; re-anchored across pages by the caller
      nickname: (user.nickname as string) || (user.nick as string) || null,
      avatarUrlOrigin: (user.avatar as string) || null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.profit_rate),
      headlinePnl: num(item.profit),
      headlineWinRate: pct(item.win_rate),
      raw: item,
    })
  }
  return { rows, reportedTotal }
}

// ── Profile ──

/** Style string "short-line|high-frequence|radical" → tags array. */
function styleTags(v: unknown): string[] | null {
  if (typeof v !== 'string' || v.length === 0) return null
  const tags = v.split('|').filter(Boolean)
  return tags.length > 0 ? tags : null
}

const FUT_TF_BLOCK: Record<number, string> = {
  7: 'seven_profit',
  30: 'month_profit',
  90: 'three_month_profit',
}

/**
 * Futures profile bundle (one TF per call, but detail covers all TFs):
 *   detail:    GET /api/copytrade/copy_trading/trader/detail/{id}
 *              → data.{config, profit, seven_profit, month_profit,
 *                three_month_profit}; profit.update_time = 数据更新时间
 *                (as_of, spec §11.10); profit.liquidation_time = 最近强制
 *                平仓时间 → extras.last_liquidation_at.
 *   profitChart: GET /apiw/v2/copy/leader/profit_chart?data_type={tok}
 *              → data.list[{profit, profit_rate, current_profit,
 *                total_invest, create_time(s)}] — cumulative 收益率/盈亏
 *                curves + daily PnL + 带单规模 curve.
 *   positionComposition: GET .../trader/position_composition?data_type={tok}
 *              → 市场偏好 donut rows.
 * ROI dual mode (spec §11.10): simple_profit_rate is the canonical roi
 * (matches the board); net-value profit_rate → extras.roi_net_value.
 */
function parseGateFuturesProfile(bundle: Dict, ctx: ParseCtx): ParsedProfile {
  const tf = (num(bundle.timeframe) ?? 30) as Timeframe
  const detail = ((bundle.detail as Dict)?.data ?? null) as Dict | null
  const config = (detail?.config ?? null) as Dict | null
  const allTime = (detail?.profit ?? null) as Dict | null
  const block = (detail?.[FUT_TF_BLOCK[tf] ?? 'month_profit'] ?? null) as Dict | null
  const user = (config?.user_info ?? allTime?.user_info ?? {}) as Dict

  const stats: ParsedStats[] = []
  if (block) {
    const winNum = int(block.win_num)
    const tradeNum = int(block.trade_num)
    const extras: Record<string, unknown> = {}
    const netValueRoi = pct(block.profit_rate)
    if (netValueRoi !== null) extras.roi_net_value = netValueRoi
    if (block.pl_ratio !== undefined) extras.pl_ratio = num(block.pl_ratio)
    if (block.average_profit !== undefined) extras.average_profit = num(block.average_profit)
    if (block.average_loss !== undefined) extras.average_loss = num(block.average_loss)
    if (block.trading_frequency !== undefined)
      extras.trading_frequency = num(block.trading_frequency)
    if (block.total_invest !== undefined) extras.lead_size = num(block.total_invest)
    if (allTime) {
      const liq = isoSecs(allTime.liquidation_time)
      if (liq !== null) extras.last_liquidation_at = liq // 最近强制平仓时间
      const lastTrade = isoSecs(allTime.last_trade_time)
      if (lastTrade !== null) extras.last_trade_at = lastTrade
      if (allTime.duration_day !== undefined) extras.leading_days = int(allTime.duration_day)
      if (allTime.total_follow_num !== undefined)
        extras.copier_count_total = int(allTime.total_follow_num)
    }
    const tags = styleTags(config?.style)
    if (tags) extras.style_labels = tags

    stats.push({
      timeframe: tf,
      // 数据更新时间 shown on the page comes from the API's update_time.
      asOf: isoSecs(allTime?.update_time) ?? ctx.scrapedAt,
      roi: pct(block.simple_profit_rate), // 简单收益率 — matches the board
      pnl: num(block.profit),
      sharpe: num(block.sharp_ratio),
      mdd: pct(block.max_drawdown),
      winRate:
        winNum !== null && tradeNum !== null && tradeNum > 0 ? (winNum / tradeNum) * 100 : null,
      winPositions: winNum,
      totalPositions: tradeNum,
      copierPnl: num(block.follow_profit),
      copierCount: int(block.curr_follow_num),
      aum: num(block.aum), // 交易员资产
      volume: num(block.leader_volume),
      profitShareRate: pct(config?.follow_fee_rate),
      holdingDurationAvgHours: null, // only per-position scatter is exposed
      tradingPreferences: composition(bundle.positionComposition),
      extras,
    })
  }

  const series = futuresSeries(bundle.profitChart, tf)

  return {
    stats,
    series,
    nickname: (user.nickname as string) || (user.nick as string) || null,
    avatarUrlOrigin: (user.avatar as string) || null,
  }
}

/** 市场偏好 donut rows pass through as trading preferences. */
function composition(payload: unknown): Dict | null {
  const data = (payload as Dict)?.data
  if (!Array.isArray(data) || data.length === 0) return null
  return { markets: data }
}

function futuresSeries(payload: unknown, tf: Timeframe): ParsedProfile['series'] {
  const list = ((payload as Dict)?.data as Dict)?.list
  if (!Array.isArray(list)) return []
  const roi: SeriesPoint[] = []
  const pnl: SeriesPoint[] = []
  const pnlDaily: SeriesPoint[] = []
  const leadSize: SeriesPoint[] = []
  for (const row of list as Dict[]) {
    const ts = isoSecs(row.create_time)
    if (ts === null) continue
    const r = pct(row.profit_rate)
    if (r !== null) roi.push({ ts, value: r })
    const p = num(row.profit)
    if (p !== null) pnl.push({ ts, value: p })
    const d = num(row.current_profit)
    if (d !== null) pnlDaily.push({ ts, value: d })
    const a = num(row.total_invest)
    if (a !== null) leadSize.push({ ts, value: a })
  }
  const series: ParsedProfile['series'] = []
  if (roi.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roi })
  if (pnl.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnl })
  if (pnlDaily.length > 0) series.push({ timeframe: tf, metric: 'pnl_daily', points: pnlDaily })
  if (leadSize.length > 0) series.push({ timeframe: tf, metric: 'lead_size', points: leadSize })
  return series
}

/**
 * CFD profile bundle (cycle = 7|30|90):
 *   tradeInfo: GET /apiw/v2/copy_tradfi/leader/trade/info?cycle → per-TF 带单数据
 *   leadInfo:  GET /apiw/v2/copy_tradfi/leader/lead/info → realtime 带单总览
 *   yieldData: GET /apiw/v2/copy_tradfi/leader/yield?leader_ids&cycle
 *              → data.list[0].leader_yield_curves[{profit, profit_rate, create_time}]
 */
function parseGateCfdProfile(bundle: Dict, ctx: ParseCtx): ParsedProfile {
  const tf = (num(bundle.timeframe) ?? 30) as Timeframe
  const info = ((bundle.tradeInfo as Dict)?.data ?? null) as Dict | null
  const lead = ((bundle.leadInfo as Dict)?.data ?? null) as Dict | null
  const user = (lead?.user_info ?? {}) as Dict

  const stats: ParsedStats[] = []
  if (info) {
    const extras: Record<string, unknown> = {}
    if (info.daily_trade_freq !== undefined) extras.trading_frequency = num(info.daily_trade_freq)
    if (info.profit_loss_ratio !== undefined) extras.pl_ratio = num(info.profit_loss_ratio)
    if (info.net_asset_value !== undefined) extras.net_asset_value = num(info.net_asset_value)
    const lastTrade = isoSecs(info.latest_trade_at)
    if (lastTrade !== null) extras.last_trade_at = lastTrade
    if (lead) {
      if (lead.leading_days !== undefined) extras.leading_days = int(lead.leading_days)
      if (lead.settled_share_profit !== undefined)
        extras.settled_share_profit = num(lead.settled_share_profit)
    }
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt, // tradfi API exposes no data-updated timestamp
      roi: pct(info.profit_rate),
      pnl: num(info.profit),
      sharpe: num(info.sharp_rate),
      mdd: pct(info.max_draw_down),
      winRate: pct(info.win_rate),
      winPositions: int(info.win_count),
      totalPositions: int(info.trade_count),
      copierPnl: num(info.follow_profit),
      copierCount: int(lead?.curr_follow_num),
      aum: num(lead?.aum),
      volume: null,
      profitShareRate: pct(lead?.share_rate),
      holdingDurationAvgHours: null,
      tradingPreferences: null, // no preference donut on tradfi profiles
      extras,
    })
  }

  const curves = (((bundle.yieldData as Dict)?.data as Dict)?.list ?? []) as Dict[]
  const points = Array.isArray(curves) ? ((curves[0]?.leader_yield_curves ?? []) as Dict[]) : []
  const roi: SeriesPoint[] = []
  const pnl: SeriesPoint[] = []
  for (const row of points) {
    const ts = isoSecs(row.create_time)
    if (ts === null) continue
    const r = pct(row.profit_rate)
    if (r !== null) roi.push({ ts, value: r })
    const p = num(row.profit)
    if (p !== null) pnl.push({ ts, value: p })
  }
  const series: ParsedProfile['series'] = []
  if (roi.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roi })
  if (pnl.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnl })

  return {
    stats,
    series,
    nickname: (user.nickname as string) || (user.nick as string) || null,
    avatarUrlOrigin: (user.avatar as string) || null,
  }
}

export function parseGateProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as Dict
  if (bundle.tradeInfo || bundle.leadInfo) return parseGateCfdProfile(bundle, ctx)
  return parseGateFuturesProfile(bundle, ctx)
}

// ── Positions ──

/**
 * Futures open positions: GET /apiw/v2/copy/leader/position → data: [...].
 * size is in contracts; quanto_multiplier converts to base qty — we store
 * the margin as size proxy is WRONG here, so keep contract size and put
 * margin/qty detail in raw. CFD positions endpoint is auth-gated (无效参数
 * 用户 ID) — gate_cfd sources keep positions_topn=0.
 */
export function parseGatePositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const data = (raw as Dict)?.data
  if (!Array.isArray(data)) return []
  const out: ParsedPosition[] = []
  for (const item of data as Dict[]) {
    const symbol = item.market
    if (!symbol) continue
    const size = num(item.size)
    out.push({
      symbol: String(symbol),
      // futures position list has no side field; sign of size carries it
      side: size === null ? null : size >= 0 ? 'long' : 'short',
      leverage: num(item.cross_leverage_limit) ?? num(item.leverage),
      size,
      entryPrice: num(item.entry_price),
      markPrice: num(item.last_price),
      unrealizedPnl: num(item.unrealised_pnl),
      raw: item,
    })
  }
  return out
}

// ── Histories ──

/** Futures 历史带单: GET /apiw/v2/copy/leader/close_position → data: [...] */
export function parseGatePositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const data = (raw as Dict)?.data
  if (!Array.isArray(data)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of data as Dict[]) {
    const symbol = item.market
    if (!symbol || item.id === undefined) continue
    out.push({
      kind: 'position_history',
      openedAt: isoSecs(item.open_time),
      closedAt: isoSecs(item.create_time), // row is created at close
      symbol: String(symbol),
      side: typeof item.side === 'string' ? item.side : null,
      leverage: num(item.cross_leverage_limit) ?? num(item.leverage),
      size: num(item.size),
      entryPrice: num(item.entry_price),
      exitPrice: num(item.close_price),
      realizedPnl: num(item.pnl ?? item.profit),
      dedupeHash: dedupeHash('gate_ph', item.id),
      raw: item,
    })
  }
  return out
}

/** CFD 历史仓位: GET /apiw/v2/copy_tradfi/leader/positions/history → data.list */
export function parseGateCfdPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const list = ((raw as Dict)?.data as Dict)?.list
  if (!Array.isArray(list)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of list as Dict[]) {
    const symbol = item.symbol ?? item.base_symbol
    if (!symbol || item.position_id === undefined) continue
    out.push({
      kind: 'position_history',
      openedAt: isoSecs(item.entry_time),
      closedAt: isoSecs(item.close_time),
      symbol: String(symbol),
      side: typeof item.position_dir === 'string' ? item.position_dir.toLowerCase() : null,
      leverage: num(item.leverage),
      size: num(item.size_close ?? item.size),
      entryPrice: num(item.entry_price),
      exitPrice: num(item.close_price),
      realizedPnl: num(item.realized_pnl),
      dedupeHash: dedupeHash('gate_cfd_ph', item.position_id),
      raw: item,
    })
  }
  return out
}

/** Futures 成交记录: GET /apiw/v2/copy/leader/history_order_list → data: [...]
 *  Rows have no id — natural-key hash over the full field tuple. */
export function parseGateOrders(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const data = (raw as Dict)?.data
  if (!Array.isArray(data)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of data as Dict[]) {
    const ts = isoSecs(item.create_time)
    if (!item.market || ts === null) continue
    out.push({
      kind: 'orders',
      ts,
      orderKind: 'fill',
      symbol: String(item.market),
      side: typeof item.side === 'string' ? item.side : null,
      price: num(item.average_price),
      qty: num(item.trading_volumn),
      dedupeHash: dedupeHash(
        'gate_or',
        item.market,
        item.create_time,
        item.side,
        item.trading_volumn,
        item.average_price
      ),
      raw: item,
    })
  }
  return out
}

/** Futures 划转记录: GET /apiw/v2/copy/leader/transfer_records → data: [...]
 *  side 1 = 转入 (in), 2 = 转出 (out); amount sign matches. */
export function parseGateTransfers(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const data = (raw as Dict)?.data
  if (!Array.isArray(data)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of data as Dict[]) {
    const ts = isoSecs(item.time)
    const amount = num(item.amount)
    if (ts === null || amount === null) continue
    const side = int(item.side)
    out.push({
      kind: 'transfers',
      ts,
      direction: side === 1 ? 'in' : side === 2 ? 'out' : null,
      asset: 'USDT',
      amount: Math.abs(amount),
      dedupeHash: dedupeHash('gate_tr', item.time, item.amount, item.side),
      raw: item,
    })
  }
  return out
}

/**
 * Copiers — futures: GET .../trader/follow_user (top-10 only, spec §11.10);
 * CFD: GET /apiw/v2/copy_tradfi/leader/public/followers → data.list.
 * Labels stored for dedupe only — NEVER rendered (spec §6 PII).
 */
export function parseGateCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const data = (raw as Dict)?.data
  const rows = Array.isArray(data) ? (data as Dict[]) : ((data as Dict)?.list as Dict[])
  if (!Array.isArray(rows)) return []
  const out: ParsedHistoryRow[] = []
  for (const item of rows) {
    if (item.follow_id !== undefined) {
      // futures shape
      out.push({
        kind: 'copiers',
        ts: isoSecs(item.create_time) ?? ctx.scrapedAt,
        copierLabel: String(item.follow_id),
        copierPnl: num(item.profit),
        copierInvested: num(item.follow_money),
        copyDurationDays: null,
        dedupeHash: dedupeHash('gate_cp', item.follow_id, item.create_time),
        raw: item,
      })
    } else if (item.nick_name !== undefined) {
      // tradfi shape (no id — tuple hash)
      out.push({
        kind: 'copiers',
        ts: ctx.scrapedAt,
        copierLabel: String(item.nick_name),
        copierPnl: num(item.total_profit),
        copierInvested: num(item.total_follow_amount),
        copyDurationDays: int(item.total_follow_day),
        dedupeHash: dedupeHash(
          'gate_cfd_cp',
          item.nick_name,
          item.total_follow_amount,
          item.total_profit
        ),
        raw: item,
      })
    }
  }
  return out
}

export function parseGateHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  const isCfd = Boolean(
    ((raw as Dict)?.data as Dict)?.list !== undefined && !Array.isArray((raw as Dict)?.data)
  )
  switch (kind) {
    case 'position_history':
      return isCfd ? parseGateCfdPositionHistory(raw, ctx) : parseGatePositionHistory(raw, ctx)
    case 'orders':
      return parseGateOrders(raw, ctx)
    case 'transfers':
      return parseGateTransfers(raw, ctx)
    case 'copiers':
      return parseGateCopiers(raw, ctx)
    default:
      throw new Error(`[gate] history surface ${kind} not supported`)
  }
}
