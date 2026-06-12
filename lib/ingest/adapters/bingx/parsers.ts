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

function results(payload: unknown): Dict[] {
  const data = (payload as Dict)?.data as Dict | undefined
  const list = data?.result
  return Array.isArray(list) ? (list as Dict[]) : []
}

/**
 * trader/search page → rows. headline metrics use the requested TF's fields;
 * the full rankStat (every period) + risk rating land on traderMeta/raw so
 * the per-TF profile-stats requirement is met from the board crawl alone.
 * apiIdentity is the profile routing key (kept on traderMeta).
 */
export function parseBingxLeaderboardPage(payload: unknown, ctx: ParseCtx): ParsedLeaderboardPage {
  const tf = (Number(ctx.meta?.timeframe) || 30) as RankingTimeframe
  const rows: ParsedLeaderboardRow[] = []
  const list = results(payload)
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    const trader = (item.trader ?? {}) as Dict
    const rankStat = (item.rankStat ?? {}) as Dict
    // uid loses precision as a JSON number — prefer a string form if present.
    const uid = trader.uidStr ?? trader.uid
    if (uid === null || uid === undefined) continue

    const traderMeta: Record<string, unknown> = {}
    if (rankStat.apiIdentity !== undefined)
      traderMeta.bingx_api_identity = String(rankStat.apiIdentity)
    // risk rating 1-10 per TF (spec §11.12) → traderMeta for routing/feature use
    const riskKey = `riskLevel${tf}Days`
    const risk = int(rankStat[riskKey])
    if (risk !== null) traderMeta.risk_rating = risk

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
      traderMeta: Object.keys(traderMeta).length > 0 ? traderMeta : null,
      raw: item,
    })
  }
  const total = int(((payload as Dict)?.data as Dict | undefined)?.total)
  return { rows, reportedTotal: total }
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
