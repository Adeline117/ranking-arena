/**
 * OKX Wallet web3 (Solana) pure parsers (spec §7 #29, §11.18).
 *
 * Inputs are the composite RAW payloads the adapter stores:
 *   leaderboard page: { data: <ranking/content data>, timeframe } — data
 *     carries rankingInfos + totalCount (rankStart/rankEnd windowing)
 *   profile:          { summary: <wallet-profile/summary response>, timeframe }
 *
 * Unit ground truth (verified live 2026-06-12):
 *   - roi / winRate / totalPnlRoi / totalWinRate are CANONICAL PERCENT
 *     already (board roi 213.70057… = summary totalPnlRoi 213.70)
 *   - pnl / volume / avgBuySize are USD strings
 *   - walletAddress is base58 — CASE-SENSITIVE, never lowercase
 *   - labels = wallet category chips (sniper/dev/fresh/pump smart money/
 *     influencers, spec §11.18) → traderMeta.okx_web3_labels
 *   - summary.datePnlList = daily PnL (the §11.18 PnL calendar substrate)
 */

import type {
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
  RankingTimeframe,
} from '../../core/types'

type Dict = Record<string, unknown>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ── Leaderboard ──

export function parseOkxWeb3LeaderboardPage(raw: unknown, _ctx: ParseCtx): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as { data?: unknown }
  const data = (payload.data ?? {}) as Dict
  const items = Array.isArray(data.rankingInfos) ? (data.rankingInfos as Dict[]) : []

  const rows: ParsedLeaderboardRow[] = []
  for (const item of items) {
    const address = String(item.walletAddress ?? '').trim() // base58 — keep case!
    if (address.length < 32) continue // no identity → cannot publish

    const labels = Array.isArray(item.labels)
      ? (item.labels as unknown[]).map((l) => String(l)).filter((l) => l.length > 0)
      : []
    rows.push({
      exchangeTraderId: address,
      rank: rows.length + 1, // page-local; tier-a re-anchors by page_size
      nickname: str(item.addressAlias) ?? str(item.walletName),
      avatarUrlOrigin: str(item.walletIconUrl),
      walletAddress: address, // spec §1.4 on-chain identity
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: num(item.roi), // already canonical percent
      headlinePnl: num(item.pnl),
      headlineWinRate: num(item.winRate), // already canonical percent
      // wallet category chips (spec §11.18) — durable per-trader facts
      traderMeta: labels.length > 0 ? { okx_web3_labels: labels } : null,
      raw: item, // pnlHistory sparkline + topTokens + volume verbatim
    })
  }

  return { rows, reportedTotal: num(data.totalCount) }
}

// ── Profile ──

/**
 * wallet-profile/summary for one periodType → superset stats + the daily
 * PnL series (the site's PnL calendar). All percents already canonical.
 */
export function parseOkxWeb3Profile(raw: unknown, ctx: ParseCtx): ParsedProfile {
  const payload = (raw ?? {}) as { summary?: unknown; timeframe?: unknown }
  const tfNum = num(payload.timeframe) ?? 30
  const tf = (tfNum === 0 ? 90 : tfNum) as RankingTimeframe
  const root = (payload.summary ?? {}) as { code?: unknown; data?: unknown }
  const s = (root.data ?? null) as Dict | null

  const stats: ParsedProfile['stats'] = []
  const series: ParsedProfile['series'] = []
  if (s) {
    const volBuy = num(s.totalVolumeBuy)
    const volSell = num(s.totalVolumeSell)
    stats.push({
      timeframe: tf,
      asOf: ctx.scrapedAt,
      roi: num(s.totalPnlRoi),
      pnl: num(s.totalPnl),
      sharpe: null,
      mdd: null,
      winRate: num(s.totalWinRate),
      winPositions: null, // tx-count win/loss split is token-level here
      totalPositions: null,
      copierPnl: null, // wallet leaderboard — no copy stats exposed
      copierCount: null,
      aum: null, // nativeTokenBalanceUsd is SOL balance only → extras
      volume: volBuy !== null || volSell !== null ? (volBuy ?? 0) + (volSell ?? 0) : null,
      profitShareRate: null,
      holdingDurationAvgHours: null,
      tradingPreferences: null,
      extras: {
        unrealized_pnl: num(s.unrealizedPnl),
        unrealized_pnl_roi: num(s.unrealizedPnlRoi),
        native_balance_usd: num(s.nativeTokenBalanceUsd),
        native_balance_amount: num(s.nativeTokenBalanceAmount),
        txs_buy: num(s.totalTxsBuy),
        txs_sell: num(s.totalTxsSell),
        volume_buy: volBuy,
        volume_sell: volSell,
        avg_cost_buy: num(s.avgCostBuy),
        // §11.18 preferred-market-cap buckets + win-rate distribution
        favorite_mcap_type: num(s.favoriteMcapType),
        mcap_txs_buy: Array.isArray(s.mcapTxsBuyList) ? s.mcapTxsBuyList : null,
        win_rate_distribution: Array.isArray(s.newWinRateDistribution)
          ? s.newWinRateDistribution
          : null,
        top_tokens_total_pnl: num(s.topTokensTotalPnl),
      },
    })

    const datePnl = Array.isArray(s.datePnlList) ? (s.datePnlList as Dict[]) : []
    const points: Array<{ ts: number; value: number }> = []
    for (const p of datePnl) {
      const ts = num(p.timestamp)
      const value = num(p.profit)
      if (ts !== null && value !== null) points.push({ ts, value })
    }
    points.sort((a, b) => a.ts - b.ts)
    if (points.length > 0) {
      series.push({
        timeframe: tf,
        metric: 'pnl_daily', // PnL-calendar substrate (spec §11.18)
        points: points.map((p) => ({ ts: new Date(p.ts).toISOString(), value: p.value })),
      })
    }
  }

  return {
    stats,
    series,
    nickname: null, // board rows carry alias/walletName; summary doesn't
    avatarUrlOrigin: null,
  }
}

// ── Positions / histories: out of v1 ──

/** Portfolio/History tabs ride different priapi families — deferred;
 *  capabilities flag them off so Tier-D/history jobs never schedule. */
export function parseOkxWeb3Positions(_raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  throw new Error('[okx_web3] positions surface not supported')
}

export function parseOkxWeb3History(
  _raw: unknown,
  kind: HistoryKind,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  throw new Error(`[okx_web3] history surface ${kind} not supported`)
}
