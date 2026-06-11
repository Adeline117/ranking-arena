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

import type {
  ParseCtx,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
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

export const BITGET_TF_PARAM: Record<7 | 30 | 90, number> = { 7: 1, 30: 2, 90: 3 }

/** trader/detail payload (one timeframe) + optional profitList payload. */
export function parseBitgetProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = raw as { detail?: Dict; profitList?: Dict; timeframe?: number }
  const tf = (bundle.timeframe ?? 90) as Timeframe
  const info = ((bundle.detail as Dict)?.data ?? null) as Dict | null

  const stats: ParsedStats[] = []
  if (info) {
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: pct(info, 'roi', ['profitRate', 'returnRate']),
      pnl: num(info.profit),
      sharpe: null, // Bitget does not expose Sharpe — NULL means "not exposed"
      mdd: pct(info, 'drawDown', ['maxDrawdown']),
      winRate: pct(info, 'winRate', ['winningRate']),
      winPositions: int(info.winOrder),
      totalPositions: int(info.totalOrder),
      copierPnl: num(info.copyTraderProfit ?? info.traceProfit),
      copierCount: int(info.copyTraderNum ?? info.traceUserNum),
      aum: num(info.totalFollowAssets),
      volume: null,
      profitShareRate: num(info.profitShareRate ?? info.shareRatio),
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {},
    })
  }

  const profitList = ((bundle.profitList as Dict)?.data ?? []) as Array<Dict>
  const series: ParsedProfile['series'] = []
  if (Array.isArray(profitList) && profitList.length > 0) {
    const points = profitList
      .map((item) => {
        const ts = num(item.date)
        const value = num(item.profit)
        if (ts === null || value === null) return null
        return { ts: new Date(ts).toISOString(), value }
      })
      .filter((p): p is { ts: string; value: number } => p !== null)
    if (points.length > 0) {
      series.push({ timeframe: tf, metric: 'pnl', points })
    }
  }

  return {
    stats,
    series,
    nickname: info ? ((info.traderName as string) ?? null) : null,
    avatarUrlOrigin: info ? ((info.headUrl as string) ?? null) : null,
  }
}
