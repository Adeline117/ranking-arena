/**
 * OKX CEX copy-trading pure parsers (spec §7 #9).
 *
 * Unit ground truth (verified live 2026-06-12 from the SG VPS):
 *   - pnlRatio / winRatio are DECIMAL FRACTIONS → ×100
 *   - pnl / aum / margin / upl are USDT strings (ccy on every block)
 *   - public-pnl series is newest-first CUMULATIVE-from-window-start
 *     (oldest point = 0) → window totals = the newest point
 *   - public-stats profitDays+lossDays sum to exactly the lastDays window
 *     (7/30/90) — they are DAYS, not positions → extras, never win/total
 *   - subpositions-history closeTime/closeAvgPx may be "" on partially
 *     closed legs → null, never 0
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

/** Decimal fraction → canonical percent (0.7157 → 71.57). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** ms-epoch string → ISO; "" / 0 / garbage → null. */
function iso(v: unknown): string | null {
  const n = num(v)
  return n === null || n <= 0 ? null : new Date(n).toISOString()
}

/** Deterministic natural-key hash for idempotent history upserts. */
export function dedupeHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

function dataRows(block: unknown): Dict[] {
  const d = (block ?? {}) as { data?: unknown }
  return Array.isArray(d.data) ? (d.data as Dict[]) : []
}

// ── Leaderboard ──

export function parseOkxLeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as { board?: { ranks?: unknown } }
  const ranks = Array.isArray(payload.board?.ranks)
    ? (payload.board!.ranks as unknown[]).filter(
        (r): r is Dict => typeof r === 'object' && r !== null && !Array.isArray(r)
      )
    : []

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < ranks.length; i++) {
    const item = ranks[i]
    const code = str(item.uniqueCode)
    if (!code) continue
    rows.push({
      exchangeTraderId: code,
      rank: i + 1, // board order within the chunk; Tier-A re-anchors
      nickname: str(item.nickName),
      avatarUrlOrigin: str(item.portLink),
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.pnlRatio), // last-90d figures (board native TF)
      headlinePnl: num(item.pnl),
      headlineWinRate: pct(item.winRatio),
      // Board carries aum (absolute USD) — was raw-only. (OKX CEX is geo-blocked
      // → no MDD on board; forward fix, effective once a VPS region reaches it.)
      headlineAum: num(item.aum),
      traderMeta: null,
      // copyTraderNum / leadDays / pnlRatios sparkline / traderInsts
      // — board-card extras kept verbatim (spec §3 raw JSONB note).
      raw: item,
    })
  }
  return { rows, reportedTotal: null } // endpoint reports pages, not rows
}

/**
 * Board-level free series (spec §13.1): each board row embeds `pnlRatios` =
 * {beginTs(ms str), pnlRatio(decimal str)} — a cumulative ROI sparkline for
 * the board's native window, so EVERY ranked trader gets a chart with no
 * extra fetch (the richer full series still arrives later via the profile
 * crawl's public-pnl endpoint and overwrites by ts on conflict). Values are
 * decimal fractions (×100), matching the board headline ROI. Tier-A only
 * crawls OKX's native TF (90), so `timeframe` is the correct window.
 */
export function parseOkxLeaderboardSeries(
  raw: unknown,
  _ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  const payload = (raw ?? {}) as { board?: { ranks?: unknown } }
  const ranks = Array.isArray(payload.board?.ranks)
    ? (payload.board!.ranks as unknown[]).filter(
        (r): r is Dict => typeof r === 'object' && r !== null && !Array.isArray(r)
      )
    : []
  for (const item of ranks) {
    const code = str(item.uniqueCode)
    if (!code) continue
    const ratios = Array.isArray(item.pnlRatios) ? (item.pnlRatios as Dict[]) : []
    const points = ratios
      .map((p) => ({ t: num(p.beginTs), value: pct(p.pnlRatio) }))
      .filter((p): p is { t: number; value: number } => p.t !== null && p.t > 0 && p.value !== null)
      .sort((a, b) => a.t - b.t)
      .map((p) => ({ ts: new Date(p.t).toISOString(), value: p.value }))
    if (points.length > 0) out.set(code, [{ timeframe, metric: 'roi', points }])
  }
  return out
}

// ── Profile (stats + cumulative pnl/roi series + coin preferences) ──

interface ProfileBundle {
  timeframe?: number
  stats?: unknown
  pnl?: unknown
  preference?: unknown
}

export function parseOkxProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as ProfileBundle
  const tf = ((bundle.timeframe === 0 ? 90 : bundle.timeframe) ?? 90) as Timeframe
  const s = dataRows(bundle.stats)[0] ?? null
  const points = dataRows(bundle.pnl)
  const preference = dataRows(bundle.preference)

  // newest-first cumulative series → sort ascending; totals = newest point.
  const asc = [...points]
    .map((p) => ({ ts: num(p.beginTs), pnl: num(p.pnl), roi: pct(p.pnlRatio) }))
    .filter((p): p is { ts: number; pnl: number | null; roi: number | null } => p.ts !== null)
    .sort((a, b) => a.ts - b.ts)
  const newest = asc.length > 0 ? asc[asc.length - 1] : null

  const stats: ParsedStats[] = []
  if (s || newest) {
    const profitDays = num(s?.profitDays)
    const lossDays = num(s?.lossDays)
    const extras: Record<string, unknown> = {}
    if (profitDays !== null) extras.profit_days = profitDays
    if (lossDays !== null) extras.loss_days = lossDays
    const investAmt = num(s?.investAmt)
    if (investAmt !== null) extras.invest_amt = investAmt
    const avgNotional = num(s?.avgSubPosNotional)
    if (avgNotional !== null) extras.avg_subpos_notional = avgNotional

    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: newest?.roi ?? null,
      pnl: newest?.pnl ?? null,
      sharpe: null,
      mdd: null, // not exposed on the public API
      winRate: pct(s?.winRatio),
      winPositions: null, // profitDays/lossDays are DAYS — kept in extras
      totalPositions: null,
      copierPnl: num(s?.curCopyTraderPnl),
      copierCount: null, // lives on the board row (entries.raw)
      aum: null,
      volume: null,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences:
        preference.length > 0
          ? {
              coins: preference.map((p) => ({ ccy: str(p.ccy), ratio: num(p.ratio) })),
            }
          : null,
      extras,
    })
  }

  const series: ParsedProfile['series'] = []
  const roiPoints = asc
    .filter((p) => p.roi !== null)
    .map((p) => ({ ts: new Date(p.ts).toISOString(), value: p.roi! }))
  if (roiPoints.length > 0) series.push({ timeframe: tf, metric: 'roi', points: roiPoints })
  const pnlPoints = asc
    .filter((p) => p.pnl !== null)
    .map((p) => ({ ts: new Date(p.ts).toISOString(), value: p.pnl! }))
  if (pnlPoints.length > 0) series.push({ timeframe: tf, metric: 'pnl', points: pnlPoints })

  return { stats, series, nickname: null, avatarUrlOrigin: null } // identity stays board-fed
}

// ── Positions (public-current-subpositions) ──

export function parseOkxPositions(raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  const out: ParsedPosition[] = []
  for (const item of dataRows(raw)) {
    const symbol = str(item.instId)
    if (!symbol) continue
    out.push({
      symbol,
      side: str(item.posSide),
      leverage: num(item.lever),
      size: num(item.subPos),
      entryPrice: num(item.openAvgPx),
      markPrice: num(item.markPx),
      unrealizedPnl: num(item.upl),
      raw: item,
    })
  }
  return out
}

// ── Histories ──

/** Closed lead positions; subPosId is the stable natural key. */
export function parseOkxPositionHistory(raw: unknown, _ctx: ParseCtx): ParsedHistoryRow[] {
  const out: ParsedHistoryRow[] = []
  for (const item of dataRows(raw)) {
    const symbol = str(item.instId)
    if (!symbol) continue
    out.push({
      kind: 'position_history',
      openedAt: iso(item.openTime),
      closedAt: iso(item.closeTime),
      symbol,
      side: str(item.posSide),
      leverage: num(item.lever),
      size: num(item.subPos),
      entryPrice: num(item.openAvgPx),
      exitPrice: num(item.closeAvgPx),
      realizedPnl: num(item.pnl),
      dedupeHash: item.subPosId
        ? dedupeHash('okx_ph', item.subPosId)
        : dedupeHash('okx_ph', symbol, item.openTime, item.closeTime, item.subPos),
      raw: item,
    })
  }
  return out
}

/**
 * public-copy-traders: one aggregate block + a top-10 copyTraders list.
 * nickName is stored for dedupe/aggregates only, NEVER rendered (spec §6
 * copier PII; sources row pins copier_table_depth='top10').
 */
export function parseOkxCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const block = dataRows(raw)[0]
  if (!block) return []
  const list = Array.isArray(block.copyTraders) ? (block.copyTraders as Dict[]) : []
  const scrapedMs = Date.parse(ctx.scrapedAt)

  const out: ParsedHistoryRow[] = []
  for (const item of list) {
    const label = str(item.nickName)
    if (!label) continue
    const begin = num(item.beginCopyTime)
    out.push({
      kind: 'copiers',
      ts: ctx.scrapedAt,
      copierLabel: label,
      copierPnl: num(item.pnl),
      copierInvested: null, // not exposed
      copyDurationDays:
        begin !== null && Number.isFinite(scrapedMs) && scrapedMs > begin
          ? Math.floor((scrapedMs - begin) / 86_400_000)
          : null,
      dedupeHash: dedupeHash('okx_cp', label, item.beginCopyTime),
      raw: {
        ...item,
        // aggregate context rides along on each row (spec §3 raw note)
        copy_total_pnl: block.copyTotalPnl ?? null,
        copy_trader_num_chg: block.copyTraderNumChg ?? null,
      },
    })
  }
  return out
}

export function parseOkxHistory(
  raw: unknown,
  kind: HistoryKind,
  ctx: ParseCtx
): ParsedHistoryRow[] {
  switch (kind) {
    case 'position_history':
      return parseOkxPositionHistory(raw, ctx)
    case 'copiers':
      return parseOkxCopiers(raw, ctx)
    default:
      // order-level records and transfers are not exposed publicly.
      throw new Error(`[okx] history surface ${kind} not supported`)
  }
}
