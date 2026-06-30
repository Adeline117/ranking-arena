/**
 * Phemex Futures copy-trading pure parsers — spec §7 #30 / §11.19.
 * Currency is USDT (sources.currency); copyTradeData money objects carry
 * their own {currency:'USD', amount} — kept verbatim in raw/extras.
 *
 * Number conventions (verified by live capture 2026-06-11): numerics are
 * STRINGS; rates (pnlRate30d/90d, tradeWinRate*, mdd*, profitShareRateRr,
 * chart value, symbol-metric value) are plain fractions ("0.4303" = 43.03%)
 * — we store percent, matching the other adapters. Timestamps are MS epochs
 * (UTC). avgPositionHoldTimeNs{tf}d is the SUM of hold time (ns) over the
 * window — stored raw in extras, never guessed into an average.
 *
 * Board model (spec §11.19 — 30/90 only, NO 7d): one endpoint serves both
 * TF boards. Every recommend row carries 30d AND 90d metric variants and
 * the site's TF dropdown is purely client-side (verified: switching TF
 * refires the identical request). The adapter wraps each page as a
 * composite { board|aiList, timeframe } so parsing stays a pure function of
 * stored RAW (spec §5.5).
 *
 * Endpoint payload shapes (base api10.phemex.com/phemex-lb/public/data):
 *   leaderboard: GET v3/user/recommend?hideFullyCopied=false&keyword=
 *                  &pageNum&pageSize≤50&showChart&sortBy=
 *                → { data: { total, rows: [card...] } } (displayWeight order)
 *   AI traders:  GET v3/ai-trader/list?lang=en  → { data: [trader...] }
 *                tags ["AI_TRADER"] → trader_kind='bot', strategy='ai'
 *                (house carousel: Stoic Triad, Apex Fader, ... spec §11.19)
 *   profile bundle: { user, pnlRateChart, pnlChart, symbolMetric, timeframe }
 *     - v3/user?lang=en&userId=            accountData/tradeData/copyTradeData
 *     - user/pnl-rate-chart?period={30,90}&userId=   ROI chart
 *     - user/pnl-chart?period={30,90}&userId=        PNL chart
 *     - v3/user/symbol-metric?userId=      preference donut keyed '30d'/'90d'
 *   positions:   GET position/current/v2?pageNum&pageSize&userId
 *   history:     GET position/closed/v2?pageNum&pageSize&userId
 *   copiers:     no public copier table (aggregate Copiers' Profit only).
 *   Commentary tab: SKIPPED by design (spec §11.19).
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

/** Fraction → percent without float dust ("0.4303" → 43.03). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.round(n * 1e6) / 1e4
}

/** Phemex epochs are MILLISECONDS. */
function iso(msEpoch: unknown): string | null {
  const n = num(msEpoch)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

function data(payload: unknown): unknown {
  return (payload as Dict)?.data
}

function isAiTrader(item: Dict): boolean {
  return Array.isArray(item.tags) && (item.tags as unknown[]).includes('AI_TRADER')
}

/** posSide 'Long'/'Short' (fall back to side 'Buy'/'Sell'). */
function side(item: Dict): 'long' | 'short' | null {
  const ps = item.posSide
  if (ps === 'Long') return 'long'
  if (ps === 'Short') return 'short'
  if (item.side === 'Buy') return 'long'
  if (item.side === 'Sell') return 'short'
  return null
}

/** Money object {currency, amount} → number (amount only; currency in raw). */
function moneyAmount(v: unknown): number | null {
  if (!v || typeof v !== 'object') return null
  return num((v as Dict).amount)
}

interface LeaderboardComposite {
  board?: unknown
  aiList?: unknown
  timeframe?: number
}

/** Pick the per-TF variant of a metric family ('pnlRate' → pnlRate30d). */
function tfField(item: Dict, family: string, tf: number): unknown {
  return item[`${family}${tf}d`]
}

function cardRow(item: Dict, positionalRank: number, tf: number): ParsedLeaderboardRow | null {
  if (item.userId === null || item.userId === undefined) return null
  const ai = isAiTrader(item)
  const copyData = (item.copyTradeData ?? {}) as Dict
  return {
    exchangeTraderId: String(item.userId),
    rank: positionalRank, // positional; re-anchored across pages by the caller
    nickname: (item.nickName as string) ?? null,
    // avatar is a RELATIVE path on an unidentified CDN — kept in raw only.
    avatarUrlOrigin:
      typeof item.avatar === 'string' && item.avatar.startsWith('http') ? item.avatar : null,
    walletAddress: null,
    traderKind: ai ? 'bot' : 'human',
    botStrategy: ai ? 'ai' : null,
    headlineRoi: pct(tfField(item, 'pnlRate', tf)),
    headlinePnl: num(tfField(item, 'pnl', tf)),
    headlineWinRate: pct(tfField(item, 'tradeWinRate', tf)),
    // Per-TF MDD (mdd{tf}d, fraction→pct) + AUM (absolute USD) — were raw-only,
    // so board-tier traders had no MDD/AUM (profile captured them for top-N).
    headlineMdd: pct(tfField(item, 'mdd', tf)),
    headlineAum: num(item.aum),
    traderMeta: ai ? { ai_trader: true } : null,
    // Both TF variants, copier slots, profit share, star flag,
    // aiDescription... kept verbatim (spec §3 raw JSONB note).
    raw: { ...item, copyTradeData: copyData },
  }
}

/**
 * Composite page: { board: <recommend resp>, timeframe } for the main board
 * or { aiList: <ai-trader/list resp>, timeframe } for the house AI carousel
 * (appended as a final page; duplicates collapse in staging dedupe).
 */
export function parsePhemexLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const composite = (raw ?? {}) as LeaderboardComposite
  const tf = composite.timeframe === 90 ? 90 : 30

  let items: Dict[] = []
  let reportedTotal: number | null = null
  if (composite.aiList !== undefined) {
    const list = data(composite.aiList)
    items = Array.isArray(list) ? (list as Dict[]) : []
  } else {
    const d = data(composite.board) as Dict | null
    items = Array.isArray(d?.rows) ? (d.rows as Dict[]) : []
    reportedTotal = int(d?.total)
  }

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const row = cardRow(items[i], i + 1, tf)
    if (row) rows.push(row)
  }
  return { rows, reportedTotal }
}

interface ProfileBundle {
  user?: unknown
  pnlRateChart?: unknown
  pnlChart?: unknown
  symbolMetric?: unknown
  timeframe?: number
}

/** {rows:[{time ms, value}]} chart → series points. */
function chartPoints(
  payload: unknown,
  decode: (v: unknown) => number | null
): Array<{ ts: string; value: number }> {
  const d = data(payload) as Dict | null
  const rows = Array.isArray(d?.rows) ? (d.rows as Dict[]) : []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows) {
    const ts = iso(row.time)
    const value = decode(row.value)
    if (ts === null || value === null) continue
    points.push({ ts, value })
  }
  return points
}

/**
 * Profile bundle, one per TF (30/90). All stats blocks in v3/user carry
 * per-TF field variants — genuinely TF-scoped (unlike most long-tail
 * sources whose overview blocks are all-time).
 */
export function parsePhemexProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = (bundle.timeframe === 90 ? 90 : 30) as Timeframe
  const user = data(bundle.user) as Dict | null
  const account = (user?.accountData ?? null) as Dict | null
  const trade = (user?.tradeData ?? null) as Dict | null
  const copy = (user?.copyTradeData ?? null) as Dict | null
  const metric = data(bundle.symbolMetric) as Dict | null

  const stats: ParsedStats[] = []
  if (user) {
    const extras: Record<string, unknown> = {}
    if (account?.totalBalance !== undefined) extras.total_balance = num(account.totalBalance)
    if (account?.totalPnl !== undefined) extras.total_pnl = num(account.totalPnl)
    if (account?.totalPnlRate !== undefined) extras.total_roi = pct(account.totalPnlRate)
    if (user.followerCount !== undefined) extras.follower_count = int(user.followerCount)
    if (user.starTrader !== undefined) extras.star_trader = Boolean(user.starTrader)
    if (Array.isArray(user.tags) && (user.tags as unknown[]).length > 0) extras.tags = user.tags
    if (isAiTrader(user)) extras.ai_trader = true
    if (copy?.maxCopierCount !== undefined) extras.max_copier_slots = int(copy.maxCopierCount)
    if (copy?.copierTotalRealizedPnl !== undefined) {
      extras.copier_total_realized_pnl = moneyAmount(copy.copierTotalRealizedPnl)
    }
    if (Array.isArray(trade?.preferenceSymbols)) {
      extras.preference_symbols = trade.preferenceSymbols
    }
    if (trade?.totalTradeVolume !== undefined) {
      extras.total_trade_volume = num(trade.totalTradeVolume)
    }
    // SUM of position hold time over the window (ns) — raw, not averaged.
    const holdNs = num(trade?.[`avgPositionHoldTimeNs${tf}d`])
    if (holdNs !== null) extras.position_hold_time_total_ns = holdNs

    const prefRows = metric?.[`${tf}d`]
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(account?.[`pnlRate${tf}d`]),
      pnl: num(account?.[`pnl${tf}d`]),
      sharpe: null,
      mdd: pct(trade?.[`mdd${tf}d`]),
      winRate: pct(trade?.[`tradeWinRate${tf}d`]),
      winPositions: int(trade?.[`tradeWinCount${tf}d`]),
      totalPositions: int(trade?.[`tradeCount${tf}d`]),
      copierPnl: moneyAmount(copy?.[`copierRealizedPnl${tf}d`]),
      copierCount: int(copy?.copierCount),
      aum: num(account?.aum),
      volume: num(trade?.[`cptTradeVolume${tf}d`]),
      profitShareRate: pct(copy?.profitShareRateRr),
      holdingDurationAvgHours: null, // see extras.position_hold_time_total_ns
      tradingPreferences: Array.isArray(prefRows) ? { symbols: prefRows } : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = chartPoints(bundle.pnlRateChart, pct)
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = chartPoints(bundle.pnlChart, num)
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })

  return {
    stats,
    series,
    nickname: user ? ((user.nickName as string) ?? null) : null,
    avatarUrlOrigin:
      user && typeof user.avatar === 'string' && user.avatar.startsWith('http')
        ? user.avatar
        : null,
  }
}

/** Current positions (GET position/current/v2, { total, rows }). */
export function parsePhemexPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const d = data(raw) as Dict | null
  const rows = Array.isArray(d?.rows) ? (d.rows as Dict[]) : []
  const out: ParsedPosition[] = []
  for (const item of rows) {
    if (!item.symbol) continue
    out.push({
      symbol: String(item.symbol),
      side: side(item),
      leverage: num(item.leverage),
      size: num(item.size),
      entryPrice: num(item.avgEntryPrice),
      markPrice: null, // not exposed; liquidationPrice kept in raw
      unrealizedPnl: num(item.unRealizedPnl), // absent on most rows → null
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
 * Historical positions (GET position/closed/v2): closed positions, newest
 * first; positionId + openedTime form the natural key (positionId alone is
 * NOT globally unique — small ids like 454410 recur across traders).
 */
export function parsePhemexPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const d = data(raw) as Dict | null
  const rows = Array.isArray(d?.rows) ? (d.rows as Dict[]) : []
  const out: ParsedHistoryRow[] = []
  for (const item of rows) {
    if (!item.symbol) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.openedTime),
      closedAt: iso(item.updatedTime),
      symbol: String(item.symbol),
      side: side(item),
      leverage: num(item.leverage),
      size: num(item.size),
      entryPrice: num(item.openPrice),
      exitPrice: num(item.closePrice),
      realizedPnl: num(item.realizedPnl),
      dedupeHash: dedupeHash('phemex_ph', item.positionId, item.symbol, item.openedTime),
      raw: item,
    })
  }
  return out
}

export function parsePhemexHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parsePhemexPositionHistory(raw, ctx)
    default:
      // no public order/transfer/copier-table surfaces (Commentary skipped).
      throw new Error(`[phemex] history surface ${kind} not supported`)
  }
}
