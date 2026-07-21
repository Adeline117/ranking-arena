/**
 * Binance Wallet web3 pure parsers (spec §7 #11, §11.7).
 *
 * Input is the composite RAW payload the adapter stores per page:
 *   { board: <leaderboard/query response verbatim>, kolAddresses, timeframe }
 * kolAddresses is the KOL-board membership set (lowercase), captured once
 * per session and embedded so the KOL flag survives pure re-parse (§5.5).
 *
 * Unit ground truth (verified live 2026-06-12):
 *   - realizedPnlPercent and winRate are DECIMAL FRACTIONS → ×100
 *   - realizedPnl / totalVolume / avgBuyVolume are USD strings
 *   - balance is the BNB amount (NOT USD) → extras, never aum
 *   - tokenDistribution = the §11.7 "Token Distribution by PnL%" buckets
 *     (>500% / 0–500% / −50–0 / <−50) — kept in raw verbatim
 */

import type {
  BoardSeriesBlock,
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

/** Decimal fraction → canonical percent (0.5179… → 51.79…). */
function pct(v: unknown): number | null {
  const n = num(v)
  return n === null ? null : n * 100
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

// ── Leaderboard ──

/** §2.5d token distribution — the four "by PnL%" buckets the board carries as
 *  a flat count object. Normalized to clean keys (UI labels them); omitted when
 *  the board didn't ship the object. */
function tokenDistribution(item: Dict): Record<string, number> | null {
  const td = item.tokenDistribution as Dict | undefined
  if (!td || typeof td !== 'object') return null
  const out: Record<string, number> = {}
  const map: Record<string, string> = {
    gt500Cnt: 'gt_500', // >500%
    between0And500Cnt: 'p0_500', // 0~500%
    between0AndNegative50Cnt: 'n50_0', // -50%~0
    ltNegative50Cnt: 'lt_n50', // <-50%
  }
  for (const [src, dst] of Object.entries(map)) {
    const n = num(td[src])
    if (n !== null) out[dst] = Math.round(n)
  }
  return Object.keys(out).length > 0 ? out : null
}

/** §2.5d top earning tokens → normalized [{symbol, address, logo, profit_pct,
 *  realized_pnl}]. profitRate is a decimal fraction → percent. Capped at 10. */
function topEarningTokens(item: Dict): Array<Record<string, unknown>> | null {
  const list = Array.isArray(item.topEarningTokens) ? (item.topEarningTokens as Dict[]) : []
  const out = list.slice(0, 10).map((tk) => ({
    symbol: str(tk.tokenSymbol),
    address: str(tk.tokenAddress),
    logo: str(tk.tokenUrl),
    profit_pct: pct(tk.profitRate),
    realized_pnl: num(tk.realizedPnl),
  }))
  return out.length > 0 ? out : null
}

/** Strict UTC calendar-day decoder shared by extras and trader_series. */
function dailyPnl(item: Dict): Array<{ date: string; pnl: number }> {
  const list = Array.isArray(item.dailyPNL) ? (item.dailyPNL as Dict[]) : []
  const byDate = new Map<string, number>()
  for (const p of list) {
    const date = str(p.dt)
    const pnl = num(p.realizedPnl)
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || pnl === null) continue
    const parsed = new Date(`${date}T00:00:00.000Z`)
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) continue
    byDate.set(date, pnl) // duplicate upstream day: last value wins
  }
  return [...byDate].sort(([a], [b]) => a.localeCompare(b)).map(([date, pnl]) => ({ date, pnl }))
}

/** §2.5d PnL calendar — dailyPNL [{dt, realizedPnl}] → [{date, pnl}], sorted. */
function pnlCalendar(item: Dict): Array<{ date: string; pnl: number }> | null {
  const out = dailyPnl(item)
  return out.length > 0 ? out : null
}

/** On-chain board fields → trader_stats.extras (registry/meta-strip surfaced):
 *  avg buy size, tokens traded, total transactions, buy/sell split, last
 *  activity, plus the §2.5d structured blocks (token distribution / top earning
 *  tokens / PnL calendar) which only the board carries — binance_web3 has no
 *  profile tier (202-gated), so extras is the sole channel for them. */
function web3BoardExtras(item: Dict): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const avgBuy = num(item.avgBuyVolume)
  if (avgBuy !== null) ext.avg_buy = avgBuy
  const tokens = num(item.totalTradedTokens)
  if (tokens !== null) ext.total_traded_tokens = Math.round(tokens)
  const txns = num(item.totalTxCnt)
  if (txns !== null) ext.total_txns = Math.round(txns)
  const buyTx = num(item.buyTxCnt)
  if (buyTx !== null) ext.buy_txns = Math.round(buyTx)
  const sellTx = num(item.sellTxCnt)
  if (sellTx !== null) ext.sell_txns = Math.round(sellTx)
  const buyVol = num(item.buyVolume)
  if (buyVol !== null) ext.buy_volume = buyVol
  const sellVol = num(item.sellVolume)
  if (sellVol !== null) ext.sell_volume = sellVol
  const ms = num(item.lastActivity)
  if (ms !== null && ms > 0) ext.last_trade_time = new Date(ms).toISOString()
  // §2.5d structured blocks (NULL-collapse — only set when the board shipped them)
  const td = tokenDistribution(item)
  if (td) {
    ext.token_distribution = td
    ext.token_distribution_unit = 'pnl_percent'
  }
  const tokensTop = topEarningTokens(item)
  if (tokensTop) {
    ext.top_earning_tokens = tokensTop
    ext.top_earning_tokens_provenance = 'source_native'
  }
  const cal = pnlCalendar(item)
  if (cal) ext.pnl_calendar = cal
  return Object.keys(ext).length > 0 ? ext : null
}

export function parseBinanceWeb3LeaderboardPage(
  raw: unknown,
  _ctx: ParseCtx
): ParsedLeaderboardPage {
  const payload = (raw ?? {}) as { board?: unknown; kolAddresses?: unknown }
  const board = (payload.board ?? {}) as { data?: unknown }
  const data = (board.data ?? {}) as Dict
  const items = Array.isArray(data.data) ? (data.data as Dict[]) : []
  const kol = new Set(
    Array.isArray(payload.kolAddresses)
      ? (payload.kolAddresses as unknown[]).map((a) => String(a).toLowerCase())
      : []
  )

  const rows: ParsedLeaderboardRow[] = []
  for (const item of items) {
    const address = String(item.address ?? '')
      .trim()
      .toLowerCase()
    if (!address.startsWith('0x')) continue // no identity → cannot publish

    const isKol = kol.has(address)
    const twitter = str(item.addressTwitterUrl)
    const headlineRoi = pct(item.realizedPnlPercent)
    const headlinePnl = num(item.realizedPnl)
    const headlineWinRate = pct(item.winRate)
    rows.push({
      exchangeTraderId: address,
      rank: rows.length + 1, // page-local; tier-a re-anchors by page_size
      nickname: str(item.addressLabel),
      avatarUrlOrigin: str(item.addressLogo),
      walletAddress: address, // spec §1.4 on-chain identity (copyable on site)
      traderKind: 'human',
      botStrategy: null,
      headlineRoi,
      headlinePnl,
      headlineWinRate,
      headlineMetricSources: {
        ...(headlineRoi === null
          ? {}
          : { roi: { fieldPath: 'board.data.data[].realizedPnlPercent' } }),
        ...(headlinePnl === null ? {} : { pnl: { fieldPath: 'board.data.data[].realizedPnl' } }),
        ...(headlineWinRate === null
          ? {}
          : { win_rate: { fieldPath: 'board.data.data[].winRate' } }),
      },
      // Board IS the stats substrate (profile page is 202-gated and unneeded —
      // the board row carries the full §2.5d on-chain superset). NO headlineAum:
      // `balance` is the BNB amount (NOT USD, per header doc) — using it as AUM
      // wrote a garbage sub-$1 value. No USD AUM exists on this on-chain board;
      // the raw BNB balance stays in `raw` for anyone who needs it.
      headlineVolume: num(item.totalVolume),
      headlineExtras: web3BoardExtras(item),
      // durable routing/identity facts only when present (spec traderMeta)
      traderMeta:
        isKol || twitter
          ? {
              ...(isKol ? { binance_web3_kol: true } : {}),
              ...(twitter ? { twitter_url: twitter } : {}),
            }
          : null,
      raw: item, // dailyPNL sparkline + tokenDistribution buckets verbatim
    })
  }

  // The endpoint reports a page count, not a row total — the crawl loop
  // asserts completeness against `pages`; entries gate uses the rolling
  // count baseline (expected_count=NULL).
  return { rows, reportedTotal: null }
}

/**
 * Board-level free series: every row already contains daily realized PnL in
 * USD. Preserve the source-native deltas as pnl_daily and also expose their
 * date-ordered prefix sum as pnl, which is the cumulative series consumed by
 * profile and ranking charts. Missing dates stay missing; no zero is invented.
 */
export function parseBinanceWeb3LeaderboardSeries(
  raw: unknown,
  _ctx: ParseCtx,
  timeframe: RankingTimeframe
): Map<string, BoardSeriesBlock[]> {
  const out = new Map<string, BoardSeriesBlock[]>()
  const payload = (raw ?? {}) as { board?: unknown; timeframe?: unknown }
  const embeddedTimeframe = num(payload.timeframe)
  if (embeddedTimeframe !== timeframe) {
    throw new Error(
      `[binance_web3] leaderboard series timeframe mismatch: raw=${embeddedTimeframe}, expected=${timeframe}`
    )
  }

  const board = (payload.board ?? {}) as { data?: unknown }
  const data = (board.data ?? {}) as Dict
  const items = Array.isArray(data.data) ? (data.data as Dict[]) : []
  for (const item of items) {
    const address = String(item.address ?? '')
      .trim()
      .toLowerCase()
    if (!address.startsWith('0x')) continue
    const points = dailyPnl(item).map(({ date, pnl }) => ({
      ts: `${date}T00:00:00.000Z`,
      value: pnl,
    }))
    if (points.length > 0) {
      const headlinePnl = num(item.realizedPnl)
      const sum = points.reduce((total, point) => total + point.value, 0)
      const tolerance = Math.max(1e-6, Math.abs(headlinePnl ?? 0) * 1e-9)
      if (headlinePnl === null || Math.abs(sum - headlinePnl) > tolerance) {
        throw new Error(
          `[binance_web3] daily PnL sum mismatch for ${address}: daily=${sum}, headline=${headlinePnl}`
        )
      }
      let cumulative = 0
      const cumulativePoints = points.map((point) => ({
        ts: point.ts,
        value: (cumulative += point.value),
      }))
      out.set(address, [
        { timeframe, metric: 'pnl_daily', points },
        { timeframe, metric: 'pnl', points: cumulativePoints },
      ])
    }
  }
  return out
}

// ── Profile / positions / histories: not publicly reachable (v1) ──

/** Profile tabs sit behind Binance's bot-shield (the wallet-direct address
 *  page answers HTTP 202 challenge; the board UI exposes no profile XHR
 *  publicly). Tier-A board rows already carry stats + daily-PnL series, so
 *  the source runs Tier-A-only: deep_profile_topn=0 in arena.sources. */
export function parseBinanceWeb3Profile(_raw: unknown, _ctx: ParseCtx): ParsedProfile {
  throw new Error('[binance_web3] profile surface not supported (Tier-A-only source)')
}

export function parseBinanceWeb3Positions(_raw: unknown, _ctx: ParseCtx): ParsedPosition[] {
  throw new Error('[binance_web3] positions surface not supported')
}

export function parseBinanceWeb3History(
  _raw: unknown,
  kind: HistoryKind,
  _ctx: ParseCtx
): ParsedHistoryRow[] {
  throw new Error(`[binance_web3] history surface ${kind} not supported`)
}
