/**
 * Bitget Bots pure parsers (spec §11.5) — work on stored RAW payloads only.
 * Shapes verified by live capture 2026-06-11 (see bots.ts header).
 *
 * Money/percent semantics on the strategyPlatform family: profitRate is
 * already percent (cumulative since creation on board cards / inception
 * block; per-TF inside performances[]); amounts are quote-currency (USDT).
 * runTime / followerTime are MILLISECOND durations.
 */

import { createHash } from 'crypto'
import type {
  ParseCtx,
  ParsedCopierRow,
  ParsedHistoryRow,
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

function isoFromMs(v: unknown): string | null {
  const n = num(v)
  return n === null ? null : new Date(n).toISOString()
}

function botsHash(...fields: unknown[]): string {
  return createHash('sha1')
    .update(fields.map((f) => String(f ?? '')).join('|'))
    .digest('hex')
}

const BOARD_FIELDS: Record<
  string,
  { strategy: 'grid' | 'martingale'; product: 'spot' | 'futures' }
> = {
  spot_grid: { strategy: 'grid', product: 'spot' },
  futures_grid: { strategy: 'grid', product: 'futures' },
  spot_martingale: { strategy: 'martingale', product: 'spot' },
  futures_martingale: { strategy: 'martingale', product: 'futures' },
}

/** direction: 1 = 做多 (long), 2 = 做空 (short), others kept verbatim. */
function botDirection(v: unknown): string | null {
  const n = num(v)
  if (n === 1) return 'long'
  if (n === 2) return 'short'
  return n === null ? null : String(n)
}

function pairOf(item: Dict): string | null {
  const dtos = item.symbolDtos
  if (Array.isArray(dtos) && dtos.length > 0) {
    const name = (dtos[0] as Dict).symbolDisplayName
    if (typeof name === 'string') return name
  }
  const sid = item.symbolId
  return typeof sid === 'string' ? sid.replace(/_[A-Z]+$/, '') : null
}

/**
 * Board page (wrapped at fetch time as {board, payload} so the strategy/
 * product split survives in RAW): payload.data.data[] cards, totalRecord.
 * Each card = one bot instance; strategyId is both the exchange_bot_id and
 * the shadow trader's exchange_trader_id.
 */
export function parseBitgetBotsBoardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const wrapper = (raw ?? {}) as { board?: string; payload?: unknown }
  const board = wrapper.board ?? 'futures_grid'
  const info = BOARD_FIELDS[board] ?? BOARD_FIELDS.futures_grid
  const data = ((wrapper.payload as Dict)?.data ?? {}) as Dict
  const items = Array.isArray(data.data) ? (data.data as Dict[]) : []
  const reportedTotal = int(data.totalRecord)

  const rows: ParsedLeaderboardRow[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.strategyId
    if (!id) continue
    const runtimeMs = num(item.runTime)
    rows.push({
      exchangeTraderId: String(id),
      rank: i + 1,
      // Bots have no name of their own — the pair is the card title.
      nickname: pairOf(item),
      avatarUrlOrigin: (item.accountUrl as string) ?? null,
      walletAddress: null,
      traderKind: 'bot',
      botStrategy: info.strategy,
      headlineRoi: num(item.profitRate), // cumulative since creation, percent
      headlinePnl: num(item.profitAmount),
      headlineWinRate: null,
      traderMeta: {
        bot: {
          exchange_bot_id: String(id),
          product_id: item.productId ?? null,
          owner_account_id: item.strAccountId ?? null,
          owner_name: (item.userDisplayName as string) ?? (item.userName as string) ?? null,
          pair: pairOf(item),
          product_type: info.product,
          strategy: info.strategy,
          direction: botDirection(item.direction),
          created_at_origin: isoFromMs(item.createTime),
          runtime_days: runtimeMs === null ? null : Math.round(runtimeMs / 86_400_000),
          profit_share_rate: num(item.profitSharingRate),
          status: item.status === undefined ? null : String(item.status),
        },
      },
      raw: item,
    })
  }
  return { rows, reportedTotal }
}

/** profitData rows: {amount, profitRate, fullTime "YYYY-MM-DD HH:mm:ss"}.
 *  fullTime carries no zone — stored as UTC per the §5.9 UTC-everywhere rule
 *  (session timezone is pinned to UTC when capturing). */
function chartPoints(
  node: unknown,
  key: 'amount' | 'profitRate'
): Array<{ ts: string; value: number }> {
  const rows = (node as Dict)?.profitData
  if (!Array.isArray(rows)) return []
  const points: Array<{ ts: string; value: number }> = []
  for (const row of rows as Dict[]) {
    const full = row.fullTime
    const value = num(row[key])
    if (typeof full !== 'string' || value === null) continue
    points.push({ ts: `${full.replace(' ', 'T')}Z`, value })
  }
  return points
}

/**
 * Bot profile = tradeStrategyInfo payload. One payload covers everything:
 *   performances[]: per-TF stats (performanceType 7/30/90)
 *   top level: cumulative (inception) stats → stored as timeframe 0
 *              (profile only, NEVER ranked — spec §1.1/§11.5)
 *   strategySelfProfitChartDto: ~30d daily roi/pnl chart → timeframe 30
 */
export function parseBitgetBotsProfile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const bundle = (raw ?? {}) as { strategyInfo?: Dict; timeframe?: number }
  const info = ((bundle.strategyInfo as Dict)?.data ?? null) as Dict | null
  if (!info) return { stats: [], series: [], nickname: null, avatarUrlOrigin: null }

  const sharedExtras: Record<string, unknown> = {
    bot_strategy_id: info.strategyId ?? null,
    symbol: pairOf(info),
    owner_name: (info.userDisplayName as string) ?? (info.userName as string) ?? null,
  }
  if (info.leverage !== undefined) sharedExtras.leverage = num(info.leverage)

  const base = {
    asOf: ctx.scrapedAt,
    sharpe: null,
    mdd: null,
    winRate: null,
    winPositions: null,
    totalPositions: null,
    volume: null,
    holdingDurationAvgHours: null,
    tradingPreferences: null,
  }

  const stats: ParsedStats[] = []
  const perfs = Array.isArray(info.performances) ? (info.performances as Dict[]) : []
  for (const perf of perfs) {
    const tf = int(perf.performanceType)
    if (tf !== 7 && tf !== 30 && tf !== 90) continue
    stats.push({
      ...base,
      timeframe: tf as Timeframe,
      roi: num(perf.profitRate),
      pnl: num(perf.profitAmount),
      copierPnl: null,
      copierCount: null,
      aum: null,
      profitShareRate: num(info.profitSharingRate),
      extras: { ...sharedExtras, investment_amount: num(perf.investmentAmount) },
    })
  }

  // Inception block (timeframe 0): cumulative since createTime.
  const runtimeMs = num(info.runTime)
  stats.push({
    ...base,
    timeframe: 0,
    roi: num(info.profitRate),
    pnl: num(info.profitAmount),
    copierPnl: num(info.followerTotalProfit),
    copierCount: int(info.traceTotalCount),
    aum: num(info.followerInvestmentAmount),
    profitShareRate: num(info.profitSharingRate),
    extras: {
      ...sharedExtras,
      investment_amount: num(info.investmentAmount),
      created_at_origin: isoFromMs(info.createTime),
      runtime_days: runtimeMs === null ? null : Math.round(runtimeMs / 86_400_000),
    },
  })

  const series: ParsedProfile['series'] = []
  // Bot's own performance chart (board cards carry it; the profile payload
  // sometimes returns it null) → roi/pnl, daily, ~30d window.
  const roiPoints = chartPoints(info.strategySelfProfitChartDto, 'profitRate')
  if (roiPoints.length > 0) series.push({ timeframe: 30, metric: 'roi', points: roiPoints })
  const pnlPoints = chartPoints(info.strategySelfProfitChartDto, 'amount')
  if (pnlPoints.length > 0) series.push({ timeframe: 30, metric: 'pnl', points: pnlPoints })
  // 跟单收益额走势 (spec §11.5): copier profit trend — separate metric so
  // the UI's scope toggle can tell bot-own pnl from copier pnl.
  const copierPnlPoints = chartPoints(info.profitChartDto, 'amount')
  if (copierPnlPoints.length > 0) {
    series.push({ timeframe: 30, metric: 'copier_pnl', points: copierPnlPoints })
  }

  return {
    stats,
    series,
    nickname: pairOf(info),
    avatarUrlOrigin: (info.accountUrl as string) ?? null,
  }
}

/**
 * 跟单者榜单 (followRank): followers[] + lastUpdateTime. The page-disclosed
 * lastUpdateTime is the true as_of (spec §5.7) → row ts. followerTime is a
 * millisecond DURATION (time spent copying) → copy_duration_days.
 * copier_label stored for dedupe/aggregates only — NEVER rendered (§6 PII).
 */
export function parseBitgetBotsCopiers(raw: unknown, ctx: ParseCtx): ParsedHistoryRow[] {
  const data = ((raw as Dict)?.data ?? null) as Dict | null
  const followers = Array.isArray(data?.followers) ? (data.followers as Dict[]) : []
  const ts = isoFromMs(data?.lastUpdateTime) ?? ctx.scrapedAt

  const out: ParsedCopierRow[] = []
  for (const f of followers) {
    const label = (f.followerUserName ?? f.followerUserDisplayName) as string | undefined
    if (!label) continue
    const durMs = num(f.followerTime)
    out.push({
      kind: 'copiers',
      ts,
      copierLabel: String(label),
      copierPnl: num(f.followerProfitAmount),
      copierInvested: num(f.followerInvestmentAmount),
      copyDurationDays: durMs === null ? null : Math.round(durMs / 86_400_000),
      dedupeHash: botsHash(
        'bitget_bot_cp',
        label,
        f.followerProfitAmount,
        f.followerInvestmentAmount
      ),
      raw: f,
    })
  }
  return out
}
