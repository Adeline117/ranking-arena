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
  HistoryKind,
  ParseCtx,
  ParsedHistoryRow,
  ParsedLeaderboardPage,
  ParsedLeaderboardRow,
  ParsedPosition,
  ParsedProfile,
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

/** On-chain board fields → trader_stats.extras (registry/meta-strip surfaced):
 *  avg buy size, tokens traded, total transactions, last activity. lastActivity
 *  is an epoch-ms number → ISO for the last_trade_time meta chip. */
function web3BoardExtras(item: Dict): Record<string, unknown> | null {
  const ext: Record<string, unknown> = {}
  const avgBuy = num(item.avgBuyVolume)
  if (avgBuy !== null) ext.avg_buy = avgBuy
  const tokens = num(item.totalTradedTokens)
  if (tokens !== null) ext.total_traded_tokens = Math.round(tokens)
  const txns = num(item.totalTxCnt)
  if (txns !== null) ext.total_txns = Math.round(txns)
  const ms = num(item.lastActivity)
  if (ms !== null && ms > 0) ext.last_trade_time = new Date(ms).toISOString()
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
    rows.push({
      exchangeTraderId: address,
      rank: rows.length + 1, // page-local; tier-a re-anchors by page_size
      nickname: str(item.addressLabel),
      avatarUrlOrigin: str(item.addressLogo),
      walletAddress: address, // spec §1.4 on-chain identity (copyable on site)
      traderKind: 'human',
      botStrategy: null,
      headlineRoi: pct(item.realizedPnlPercent),
      headlinePnl: num(item.realizedPnl),
      headlineWinRate: pct(item.winRate),
      // Board IS the stats substrate (profile page is 202-gated and unneeded —
      // the board row carries the full §2.5d on-chain superset). Backfill AUM
      // (wallet balance), volume + on-chain extras into trader_stats.
      headlineAum: num(item.balance),
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
