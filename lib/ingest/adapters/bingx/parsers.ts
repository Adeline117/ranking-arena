/**
 * BingX pure parsers (spec §11.12) — work on stored RAW payloads only
 * (re-parse guarantee, spec §5.5).
 *
 * One adapter serves bingx_futures + bingx_spot via src.meta.boardKey. v1
 * crawls only the Perpetual product (conditions exchangeId=2). The board
 * endpoint (POST trader/search) returns an exceptionally rich row whose
 * `rankStat` carries EVERY metric for ALL periods at once (winRate7d/30d/90d,
 * sharpe7d/30d/90d, maxDrawDown{7,30,90}d, cumulativeProfitLoss{7,30,90}d,
 * strRecent{7,30,90}DaysRate, riskLevel{7,30,90}Days = the 1-10 risk rating,
 * spec §11.12) — so a single board crawl yields complete per-TF trader_stats.
 *
 * The board is signed (per-request `sign` header over body+headers, host
 * rotates qq-os.com↔we-api.com) — the adapter harvests the live signed
 * request via the page and replays pages; the parser is unaffected.
 *
 * Verified by live capture 2026-06-11 (bingx-*-debug scripts, deleted).
 */

import type {
  ParseCtx,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  RankingTimeframe,
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

/** Parse a display rate like "+1,052.28%" or "-3.20%" → 1052.28 / -3.2. */
function parseDisplayPct(v: unknown): number | null {
  if (typeof v !== 'string') return num(v)
  const cleaned = v.replace(/[%,\s]/g, '')
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

/** Decimal fraction (0.5263 = 52.63%). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

const RATE_KEY: Record<number, string> = {
  7: 'strRecent7DaysRate',
  30: 'strRecent30DaysRate',
  90: 'strRecent90DaysRate',
}
const CUM_PNL_KEY: Record<number, string> = {
  7: 'cumulativeProfitLoss7d',
  30: 'cumulativeProfitLoss30d',
  90: 'cumulativeProfitLoss90d',
}
const WIN_KEY: Record<number, string> = { 7: 'winRate7d', 30: 'winRate30d', 90: 'winRate90d' }

/** Unwrap the {search, timeframe} envelope the adapter stores in RAW (the TF
 *  is carried with the payload so the parser is pure and re-parseable — the
 *  rankStat holds all periods, so the TF can't come from the payload alone). */
function unwrap(payload: unknown): { search: unknown; timeframe: number | null } {
  const p = payload as Dict
  if (p && typeof p === 'object' && 'search' in p) {
    return { search: p.search, timeframe: num(p.timeframe) }
  }
  return { search: payload, timeframe: null }
}

function results(search: unknown): Dict[] {
  const data = (search as Dict)?.data as Dict | undefined
  const list = data?.result
  return Array.isArray(list) ? (list as Dict[]) : []
}

/**
 * trader/search page → rows. headline metrics use the requested TF's fields;
 * the full rankStat (every period) + risk rating land on traderMeta/raw so
 * the per-TF profile-stats requirement is met from the board crawl alone.
 * apiIdentity is the profile routing key (kept on traderMeta). The TF comes
 * from the RAW {search, timeframe} envelope (the adapter stores it there).
 */
export function parseBingxLeaderboardPage(payload: unknown, ctx: ParseCtx): ParsedLeaderboardPage {
  const { search, timeframe } = unwrap(payload)
  const tf = (timeframe ?? (Number(ctx.meta?.timeframe) || 30)) as RankingTimeframe
  const rows: ParsedLeaderboardRow[] = []
  const list = results(search)
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const trader = (item.trader ?? {}) as Dict
    const rankStat = (item.rankStat ?? {}) as Dict
    // uid loses precision as a JSON number — prefer a string form if present.
    const uid = trader.uidStr ?? trader.uid
    if (uid === null || uid === undefined) continue

    // Only TF-INDEPENDENT routing facts belong on traderMeta (it is one row
    // per trader). apiIdentity routes the profile; the per-TF risk rating
    // (riskLevel{7,30,90}Days, spec §11.12) is preserved in raw.rankStat and
    // belongs in per-TF trader_stats.extras, NOT here (it would be clobbered
    // by whichever TF wrote last).
    const traderMeta: Record<string, unknown> = {}
    if (rankStat.apiIdentity !== undefined)
      traderMeta.bingx_api_identity = String(rankStat.apiIdentity)

    rows.push({
      exchangeTraderId: String(uid),
      rank: i + 1, // sorted list; re-anchored across pages by the caller
      nickname: typeof trader.nickName === 'string' ? trader.nickName : null,
      avatarUrlOrigin: typeof trader.avatar === 'string' ? trader.avatar : null,
      walletAddress: null,
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: parseDisplayPct(rankStat[RATE_KEY[tf]]),
      headlinePnl: num(rankStat[CUM_PNL_KEY[tf]]),
      headlineWinRate: pct(rankStat[WIN_KEY[tf]]),
      // Board IS the stats substrate (profile pass deferred) — the rankStat row
      // carries the full superset. Backfill the per-TF risk/size columns into
      // trader_stats (publish headline upsert), matching the blofin pattern:
      // mdd/sharpe are per-TF; equity (AUM) + follower count are TF-independent.
      headlineMdd: pct(rankStat[`maxDrawDown${tf}d`]),
      headlineSharpe: num(rankStat[`sharpe${tf}d`]),
      headlineAum: parseDisplayPct(rankStat.equity),
      headlineCopierCount: int(parseDisplayPct(rankStat.strFollowerNum)),
      headlineWinPositions: int(rankStat.profitablePositionCount),
      headlineTotalPositions: int(rankStat.totalPositionCount),
      // Rich rankStat superset → trader_stats.extras (surfaced by the metric
      // registry / meta strip with no UI changes). TF-independent overall stats.
      headlineExtras: bingxBoardExtras(rankStat, tf),
      traderMeta: Object.keys(traderMeta).length > 0 ? traderMeta : null,
      raw: item,
    })
  }
  const total = int(((search as Dict)?.data as Dict | undefined)?.total)
  return { rows, reportedTotal: total }
}

/** Rich rankStat fields → trader_stats.extras (mapped to existing registry /
 *  meta-strip keys, so they surface with zero UI change). Amount fields are
 *  comma-formatted strings; lastTradeTime is already ISO. Returns null when
 *  nothing parses so the publish upsert leaves extras untouched. */
function bingxBoardExtras(rankStat: Dict, tf: RankingTimeframe): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const avgProfit = parseDisplayPct(rankStat.avgProfitAmount)
  if (avgProfit !== null) ext.avg_profit = avgProfit
  const avgLoss = parseDisplayPct(rankStat.avgLossAmount)
  if (avgLoss !== null) ext.avg_loss = avgLoss
  const tpw = num(rankStat.weeklyTradeFrequency)
  if (tpw !== null) ext.trades_per_week = tpw
  const td = int(rankStat.tradeDays)
  if (td !== null) ext.trading_days = td
  const ltt = rankStat.lastTradeTime
  if (typeof ltt === 'string' && !Number.isNaN(Date.parse(ltt))) ext.last_trade_time = ltt
  // Per-TF risk rating 1-10 (spec §11.12) — flagged Arena-Score feature. The
  // board row IS the stats substrate; riskLevel{tf}Days lives in rankStat. The
  // registry already has the `risk_rating` key — this just wires it through.
  const risk = int(rankStat[`riskLevel${tf}Days`])
  if (risk !== null) ext.risk_rating = risk
  // 盈亏比 + 累计交易数 (Phase A: were raw-only). pnlRateU can be "+∞"/"-∞"
  // for no-loss/no-win traders → num() returns null (NULL-collapse), never a bad value.
  const pnlRatio = num(rankStat.pnlRateU)
  if (pnlRatio !== null) ext.pnl_ratio = pnlRatio
  const lifetimeTrades = int(rankStat.totalTransactions)
  if (lifetimeTrades !== null) ext.lifetime_trades = lifetimeTrades
  return Object.keys(ext).length > 0 ? ext : null
}

/** All-period sharpe/mdd/risk extractor for the (future) profile pass — kept
 *  here so the per-TF stats logic lives with the row shape it parses. */
export function bingxPerTfExtras(rankStat: Dict, tf: RankingTimeframe): Record<string, unknown> {
  const extras: Record<string, unknown> = {}
  const sharpe = num(rankStat[`sharpe${tf}d`])
  if (sharpe !== null) extras.sharpe = sharpe
  const mdd = pct(rankStat[`maxDrawDown${tf}d`])
  if (mdd !== null) extras.mdd = mdd
  const risk = int(rankStat[`riskLevel${tf}Days`])
  if (risk !== null) extras.risk_rating = risk
  return extras
}
