/**
 * Toobit Futures copy-trading pure parsers (spec §7 #25).
 *
 * Unit ground truth (verified live 2026-06-12 from the SG VPS):
 *   - leaderAvgProfitRatio / leaderProfitOrderRatio / profitSharingRate /
 *     radar ratios are DECIMAL FRACTIONS → ×100
 *   - pnl / profit / totalLeadAmount / accumulate values are USDT strings
 *   - leaders MAY MASK live position fields ("****" symbol/qty/price) —
 *     masked scalars decode to null, rows without a real symbol are
 *     skipped; radar can return "--" for undefined ratios → null
 *   - accumulate-profit is a daily CUMULATIVE PnL ($) series with
 *     date strings "yyyymmdd" (UTC) — window total = the last point
 *   - history rows often carry id/orderId "0" → field-tuple dedupe
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

/** Mask-aware numeric decode: "****" (privacy mask) and "--" → null. */
function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '' || v === '****' || v === '--') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** Decimal fraction → canonical percent (0.7729 → 77.29). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

/** Mask-aware string decode. */
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v !== '****' && v !== '--' ? v : null
}

function int(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : Math.trunc(n)
}

/** ms-epoch → ISO; 0/garbage → null. */
function iso(v: unknown): string | null {
  const n = num(v)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

/** "20260606" (UTC day) → ISO midnight. */
function dayIso(v: unknown): string | null {
  const s = str(v)
  if (!s || !/^\d{8}$/.test(s)) return null
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00.000Z`
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

function objects(v: unknown): Dict[] {
  return Array.isArray(v)
    ? (v as unknown[]).filter(
        (r): r is Dict => typeof r === 'object' && r !== null && !Array.isArray(r)
      )
    : []
}

function side(isLong: unknown): string | null {
  const n = num(isLong)
  if (n === 1) return 'long'
  if (n === 0) return 'short'
  return null
}

// ── Leaderboard ──

export function parseToobitLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as { board?: { list?: unknown; total?: unknown } }
  const list = objects(payload.board?.list)

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const id = str(item.leaderUserId)
    if (!id) continue
    rows.push({
      exchangeTraderId: id,
      rank: i + 1, // board order within the page; Tier-A re-anchors
      nickname: str(item.nickname),
      avatarUrlOrigin: str(item.avatar),
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.leaderAvgProfitRatio),
      headlinePnl: num(item.pnl),
      headlineWinRate: pct(item.leaderProfitOrderRatio),
      traderMeta: null,
      // sharpeRatio / totalLeadAmount / followTotalProfit / the embedded
      // cumulative-ROI sparkline (leaderTradeProfit) — kept verbatim.
      raw: item,
    })
  }
  return { rows, reportedTotal: num((payload.board ?? {}).total) }
}

/**
 * Board-level free series (spec §13.1): each board row embeds
 * `leaderTradeProfit` = {date:"yyyymmdd", value} — the same daily cumulative
 * ROI sparkline the profile page shows, so EVERY ranked trader gets a chart
 * with no extra fetch. The board is per-TF (dataType), so the points belong
 * to `timeframe`. Values are decimal fractions (×100), matching board ROI.
 */
export function parseToobitLeaderboardSeries(
  raw: unknown,
  _ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  const payload = (raw ?? {}) as { board?: { list?: unknown } }
  for (const item of objects(payload.board?.list)) {
    const id = str(item.leaderUserId)
    if (!id) continue
    const points = objects(item.leaderTradeProfit)
      .map((p) => ({ ts: dayIso(p.date), value: pct(p.value) }))
      .filter((p): p is { ts: string; value: number } => p.ts !== null && p.value !== null)
      .sort((a, b) => a.ts.localeCompare(b.ts))
    if (points.length > 0) out.set(id, [{ timeframe, metric: 'roi', points }])
  }
  return out
}

// ── Profile (detail + radar + cumulative PnL series) ──

interface ProfileBundle {
  timeframe?: number
  detail?: { data?: unknown }
  radar?: { data?: unknown }
  accumulate?: { data?: unknown }
}

export function parseToobitProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 30) as Timeframe
  const detail = (bundle.detail?.data ?? null) as Dict | null
  const radar = (bundle.radar?.data ?? null) as Dict | null
  const accumulate = objects(bundle.accumulate?.data)

  const points = accumulate
    .map((p) => ({ ts: dayIso(p.date), value: num(p.value) }))
    .filter((p): p is { ts: string; value: number } => p.ts !== null && p.value !== null)
    .sort((a, b) => a.ts.localeCompare(b.ts))
  const windowPnl = points.length > 0 ? points[points.length - 1].value : null

  const stats: ParsedStats[] = []
  if (detail || radar || windowPnl !== null) {
    const extras: Record<string, unknown> = {}
    if (detail) {
      const leadDays = int(detail.leadDays)
      if (leadDays !== null) extras.lead_days = leadDays
      const tradeCount = int(detail.tradeCount)
      if (tradeCount !== null) extras.trade_count_lifetime = tradeCount
      const maxLead = int(detail.maxLeadCount)
      if (maxLead !== null) extras.copier_limit = maxLead
      const totalFollowers = int(detail.totalFollowerCount)
      if (totalFollowers !== null) extras.total_copiers_history = totalFollowers
      const lastWeekWr = pct(detail.lastWeekWinRate)
      if (lastWeekWr !== null) extras.last_week_win_rate = lastWeekWr
      if (typeof detail.summary === 'string' && detail.summary) extras.bio = detail.summary
      if (detail.isFull !== undefined) extras.is_full = detail.isFull === true
      const startLead = iso(detail.startLeadTime)
      if (startLead !== null) extras.start_lead_time = startLead
    }
    if (radar) {
      // Site-relative percentiles (Arena Score v2 features, spec §12.2)
      for (const k of [
        'leaderProfitRatioProportion',
        'leaderProfitOrderRatioProportion',
        'leaderMaximumDrawdownProportion',
      ]) {
        const v = num(radar[k])
        if (v !== null) extras[k] = v
      }
    }

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(radar?.leaderProfitRatio), // == board leaderAvgProfitRatio (verified)
      pnl: windowPnl,
      sharpe: null, // lives on the board row (entries.raw.sharpeRatio)
      mdd: pct(radar?.leaderMaximumDrawdown),
      winRate: pct(radar?.leaderProfitOrderRatio),
      winPositions: null,
      totalPositions: null,
      copierPnl: null,
      copierCount: detail ? int(detail.currentFollowerCount) : null,
      aum: detail ? num(detail.totalLeadAmount) : null,
      volume: null,
      profitShareRate: detail ? pct(detail.profitSharingRate) : null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  if (points.length > 0) series.push({ timeframe: tf, metric: 'pnl', points })

  return {
    stats,
    series,
    nickname: detail ? str(detail.nickname) : null,
    avatarUrlOrigin: detail ? str(detail.avatar) : null,
  }
}

// ── Positions (current-lead-orders, mask-aware) ──

export function parseToobitPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const list = objects(((raw ?? {}) as { data?: unknown }).data)
  const out: ParsedPosition[] = []
  for (const item of list) {
    const symbol = str(item.symbolId) ?? str(item.symbolName)
    if (!symbol) continue // leader masked this position ("****")
    out.push({
      symbol,
      side: side(item.isLong),
      leverage: num(item.leverage),
      size: num(item.positionQuantity) ?? num(item.quantity),
      entryPrice: num(item.openPrice),
      markPrice: num(item.markPrice),
      unrealizedPnl: num(item.profit),
      raw: item,
    })
  }
  return out
}

// ── Histories ──

/** Closed lead positions; id/orderId often "0" → field-tuple dedupe. */
export function parseToobitPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const list = objects(((raw ?? {}) as { data?: { list?: unknown } }).data?.list)
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const symbol = str(item.symbolId)
    if (!symbol) continue
    const id = str(item.id)
    out.push({
      kind: 'position_history',
      openedAt: iso(item.openTime),
      closedAt: iso(item.closeTime),
      symbol,
      side: side(item.isLong),
      leverage: num(item.leverage),
      size: num(item.openQty),
      entryPrice: num(item.openPrice),
      exitPrice: num(item.closePrice),
      realizedPnl: num(item.profit),
      dedupeHash:
        id && id !== '0'
          ? dedupeHash('toobit_ph', id)
          : dedupeHash('toobit_ph', symbol, item.openTime, item.closeTime, item.profit),
      raw: item,
    })
  }
  return out
}

/**
 * top-followers: top copiers (~6 rows). followerNickname is stored for
 * dedupe/aggregates only, NEVER rendered (spec §6 copier PII).
 */
export function parseToobitCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const list = objects(((raw ?? {}) as { data?: unknown }).data)
  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const label = str(item.followerNickname)
    if (!label) continue
    const runningMs = num(item.followRunningMills)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(item.totalFollowProfit),
      copierInvested: num(item.totalFollowAmount),
      copyDurationDays: runningMs !== null ? Math.floor(runningMs / 86_400_000) : null,
      dedupeHash: dedupeHash('toobit_cp', label, item.followRunningMills),
      raw: item,
    })
  }
  return out
}

export function parseToobitHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseToobitPositionHistory(raw, ctx)
    case 'copiers':
      return parseToobitCopiers(raw, ctx)
    default:
      // order-level records and transfers are not exposed publicly.
      throw new Error(`[toobit] history surface ${kind} not supported`)
  }
}
