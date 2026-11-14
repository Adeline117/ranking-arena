/**
 * Single row mapper for every ranking-table data path.
 *
 * The homepage used to keep two hand-written allowlist copies — one for SSR
 * `InitialTrader` rows (HomePageClient) and one for `/api/traders` rows
 * (useTraderData). Each dropped a complementary set of fields, so the same row
 * flipped badges/metrics on the first silent refresh (rank arrows + NEW
 * vanished, bot badge appeared, Verified / anti-gaming badges never showed,
 * Sharpe and Followers were always "—"). Both paths now call `toUiTrader()`.
 *
 * Input type is inferred from the core-api zod contract; values are still
 * normalized at runtime because the payload crosses a network/cache boundary.
 * Unknown stays `null` — never a synthetic zero.
 */
import type { TradersListRow } from '@/lib/contracts/core-api'
import { computeAntiGamingFlags } from '@/lib/scoring/anti-gaming'
import type { Trader } from './RankingTableTypes'

/** Fields only the SSR `InitialTrader` shape carries (legacy aliases). */
interface SsrOnlyFields {
  /** SSR alias of `sharpe_ratio`. */
  sharpe?: number | null
  score_confidence?: string | null
}

export type UiTraderInput = Partial<TradersListRow> & SsrOnlyFields & { id: string }

function finiteOrNull(value: unknown): number | null {
  const numeric =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(numeric) ? numeric : null
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function publishedRankOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function tier(value: unknown): 'full' | 'partial' | 'minimal' | null {
  return value === 'full' || value === 'partial' || value === 'minimal' ? value : null
}

function traderTypeOf(value: unknown): Trader['trader_type'] {
  return value === 'human' || value === 'bot' || value === 'suspected_bot' ? value : null
}

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? value : null
}

export function toUiTrader(row: UiTraderInput): Trader {
  const source = stringOrNull(row.source) ?? undefined
  const traderType =
    traderTypeOf(row.trader_type) ?? (source === 'web3_bot' ? ('bot' as const) : null)
  const winRate = finiteOrNull(row.win_rate)
  const tradesCount = finiteOrNull(row.trades_count)
  const followers = finiteOrNull(row.followers)

  return {
    id: row.id,
    handle: stringOrNull(row.handle),
    roi: finiteOrNull(row.roi),
    pnl: finiteOrNull(row.pnl),
    win_rate: winRate,
    max_drawdown: finiteOrNull(row.max_drawdown),
    trades_count: tradesCount,
    // `followers` is a required number on the UI type; the Followers column
    // reads `copiers ?? followers` so copiers carries the real signal.
    followers: followers ?? 0,
    copiers: finiteOrNull(row.copiers),
    source,
    avatar_url: stringOrNull(row.avatar_url),
    avatar_url_mirror: stringOrNull(row.avatar_url_mirror),
    arena_score: finiteOrNull(row.arena_score),
    rank: publishedRankOrNull(row.rank),
    rank_change: finiteOrNull(row.rank_change),
    is_new: row.is_new === true,
    // SSR derives confidence from `score_completeness` (lib/data/trader/mappers);
    // /api/traders has no confidence column, so derive it the same way here.
    // Otherwise the indicator flips to "unknown" on the first client refresh.
    score_confidence: tier(row.score_confidence) ?? tier(row.score_completeness),
    profitability_score: finiteOrNull(row.profitability_score),
    risk_control_score: finiteOrNull(row.risk_control_score),
    execution_score: finiteOrNull(row.execution_score),
    score_completeness: tier(row.score_completeness),
    trading_style: stringOrNull(row.trading_style),
    avg_holding_hours: finiteOrNull(row.avg_holding_hours),
    style_confidence: finiteOrNull(row.style_confidence),
    sharpe_ratio: finiteOrNull(row.sharpe_ratio ?? row.sharpe),
    sortino_ratio: finiteOrNull(row.sortino_ratio),
    calmar_ratio: finiteOrNull(row.calmar_ratio),
    profit_factor: finiteOrNull(row.profit_factor),
    trader_type: traderType,
    is_bot:
      row.is_bot === true ||
      source === 'web3_bot' ||
      traderType === 'bot' ||
      traderType === 'suspected_bot',
    is_verified: row.is_verified === true,
    is_verified_data: row.is_verified_data === true,
    // /api/traders derives these at read time; SSR rows carry the same inputs,
    // so derive them identically when absent instead of silently showing none.
    anti_gaming_flags:
      stringArray(row.anti_gaming_flags) ?? computeAntiGamingFlags({ winRate, tradesCount }),
  }
}
