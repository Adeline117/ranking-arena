/**
 * Safe legacy projection for /api/users/[handle]/full.
 *
 * That endpoint predates the sealed ranking reader and its old helpers mixed
 * identity, raw leaderboard rows, and fabricated zeroes. Keep the projection
 * deliberately narrow: every ranking value comes from an already-sanitized
 * public cohort row, while position PnL/value remain explicitly unknown until
 * there is a proof-bearing position publication contract.
 */

import type {
  PublicProfileRankingResult,
  PublicProfileRankingRow,
  PublicProfileRankingVisibility,
} from './public-profile-ranking'

type PublicLegacyRecord = Record<string, unknown>

export interface PublicFullProfileRankingProjection {
  performance: PublicLegacyRecord | null
  stats: PublicLegacyRecord | null
  rank90D: number | null
  arenaScore90D: number | null
  roi90D: number | null
  followers90D: number | null
  copiers90D: number | null
  rankingVisibility: PublicProfileRankingVisibility
  rankingVisibilityReason: string | null
}

export interface PublicFullTraderIdentity {
  source: string
  id: string
  handle: string
  avatarUrl: string | null
}

export type PublicFullTraderIdentityResult =
  | { identity: PublicFullTraderIdentity; reason: null }
  | {
      identity: null
      reason: 'trader_not_found' | 'trader_identity_ambiguous' | 'trader_identity_unavailable'
    }

type PublicFullTraderSourceQueryResult = {
  data: unknown[] | null
  error: { message: string } | null
}

type PublicFullTraderSourceQuery = PromiseLike<PublicFullTraderSourceQueryResult> & {
  select(columns: string): PublicFullTraderSourceQuery
  eq(column: string, value: string): PublicFullTraderSourceQuery
  limit(count: number): PublicFullTraderSourceQuery
}

type PublicFullTraderIdentityClient = {
  from(relation: 'trader_sources'): PublicFullTraderSourceQuery
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function publicFullTraderIdentityClient(value: unknown): PublicFullTraderIdentityClient {
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose trader identity records')
  }
  return value as PublicFullTraderIdentityClient
}

function parseTraderIdentityRows(value: unknown): PublicFullTraderIdentity[] | null {
  if (!Array.isArray(value)) return null
  const identities: PublicFullTraderIdentity[] = []
  for (const row of value) {
    if (!isRecord(row)) return null
    if (
      typeof row.source !== 'string' ||
      !row.source.trim() ||
      typeof row.source_trader_id !== 'string' ||
      !row.source_trader_id.trim() ||
      (row.handle !== null && row.handle !== undefined && typeof row.handle !== 'string') ||
      (row.avatar_url !== null &&
        row.avatar_url !== undefined &&
        typeof row.avatar_url !== 'string')
    ) {
      return null
    }
    const id = row.source_trader_id
    identities.push({
      source: row.source,
      id,
      handle: typeof row.handle === 'string' && row.handle.trim() ? row.handle : id,
      avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : null,
    })
  }
  return identities
}

/**
 * Resolve the request identity fresh from the canonical source table. This
 * deliberately does not call the old handle cache or use raw leaderboard rows
 * as a tie breaker: neither can prove that a rank-bearing response still
 * belongs to the handle currently being requested.
 */
export async function fetchPublicFullTraderIdentity(
  supabase: unknown,
  handle: string
): Promise<PublicFullTraderIdentityResult> {
  if (!handle) return { identity: null, reason: 'trader_not_found' }

  try {
    const client = publicFullTraderIdentityClient(supabase)
    const read = async (column: 'handle' | 'source_trader_id') => {
      const { data, error } = await client
        .from('trader_sources')
        .select('source, source_trader_id, handle, avatar_url')
        .eq(column, handle)
        .limit(2)
      if (error) return { identities: null, failed: true }
      return { identities: parseTraderIdentityRows(data ?? []), failed: false }
    }

    const byHandle = await read('handle')
    if (byHandle.failed || byHandle.identities === null) {
      return { identity: null, reason: 'trader_identity_unavailable' }
    }
    if (byHandle.identities.length > 1) {
      return { identity: null, reason: 'trader_identity_ambiguous' }
    }
    if (byHandle.identities.length === 1) {
      return { identity: byHandle.identities[0], reason: null }
    }

    const byId = await read('source_trader_id')
    if (byId.failed || byId.identities === null) {
      return { identity: null, reason: 'trader_identity_unavailable' }
    }
    if (byId.identities.length > 1) {
      return { identity: null, reason: 'trader_identity_ambiguous' }
    }
    return byId.identities.length === 1
      ? { identity: byId.identities[0], reason: null }
      : { identity: null, reason: 'trader_not_found' }
  } catch {
    return { identity: null, reason: 'trader_identity_unavailable' }
  }
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function nonNegativeIntegerOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function rankOrNull(row: PublicProfileRankingRow | null): number | null {
  if (!row || !Number.isSafeInteger(row.rank) || row.rank <= 0) return null
  return row.rank
}

function metric(row: PublicProfileRankingRow | null, key: string): number | null {
  return row ? finiteOrNull(row[key]) : null
}

function rowForPeriod(
  rows: readonly PublicProfileRankingRow[],
  period: '7D' | '30D' | '90D'
): PublicProfileRankingRow | null {
  return rows.find((row) => row.season_id === period) ?? null
}

/**
 * Project only fields whose period and measurement meaning are explicit.
 * In particular, never fall back from a missing 90D value to another window:
 * that would make an incomplete historical cohort look complete.
 */
export function projectPublicFullProfileRanking(
  cohort: PublicProfileRankingResult
): PublicFullProfileRankingProjection {
  const row90D = rowForPeriod(cohort.rows, '90D')
  const row30D = rowForPeriod(cohort.rows, '30D')
  const row7D = rowForPeriod(cohort.rows, '7D')
  const hasPublishedRow = row90D !== null || row30D !== null || row7D !== null

  const performance: PublicLegacyRecord | null = hasPublishedRow
    ? {
        roi_90d: metric(row90D, 'roi'),
        roi_30d: metric(row30D, 'roi'),
        roi_7d: metric(row7D, 'roi'),
        pnl: metric(row90D, 'pnl'),
        pnl_30d: metric(row30D, 'pnl'),
        pnl_7d: metric(row7D, 'pnl'),
        win_rate: metric(row90D, 'win_rate'),
        win_rate_30d: metric(row30D, 'win_rate'),
        win_rate_7d: metric(row7D, 'win_rate'),
        max_drawdown: metric(row90D, 'max_drawdown'),
        max_drawdown_30d: metric(row30D, 'max_drawdown'),
        max_drawdown_7d: metric(row7D, 'max_drawdown'),
        trades_count: nonNegativeIntegerOrNull(row90D?.trades_count),
        trades_count_30d: nonNegativeIntegerOrNull(row30D?.trades_count),
        trades_count_7d: nonNegativeIntegerOrNull(row7D?.trades_count),
        rank: rankOrNull(row90D),
        rank_30d: rankOrNull(row30D),
        rank_7d: rankOrNull(row7D),
        arena_score: metric(row90D, 'arena_score'),
        arena_score_90d: metric(row90D, 'arena_score'),
        arena_score_30d: metric(row30D, 'arena_score'),
        arena_score_7d: metric(row7D, 'arena_score'),
        arena_score_v3: metric(row90D, 'arena_score_v3'),
        profitability_score: metric(row90D, 'profitability_score'),
        risk_control_score: metric(row90D, 'risk_control_score'),
        execution_score: metric(row90D, 'execution_score'),
        sharpe_ratio: metric(row90D, 'sharpe_ratio'),
        sortino_ratio: metric(row90D, 'sortino_ratio'),
        profit_factor: metric(row90D, 'profit_factor'),
        calmar_ratio: metric(row90D, 'calmar_ratio'),
        score_completeness: row90D?.score_completeness === 'full' ? 'full' : null,
        metrics_estimated: row90D?.metrics_estimated === false ? false : null,
        overall_score: null,
        score_penalty: null,
      }
    : null

  // `trades_count` is a current 90D cohort field, not a 12-month statistic.
  // Keep the legacy 12M key unknown and expose the correctly named value next
  // to it for callers that can consume the newer contract.
  const stats: PublicLegacyRecord | null = row90D
    ? {
        trading: {
          totalTrades12M: null,
          totalTrades90D: nonNegativeIntegerOrNull(row90D.trades_count),
          avgProfit: null,
          avgLoss: null,
          profitableTradesPct: metric(row90D, 'win_rate'),
          winningPositions: null,
          totalPositions: null,
        },
        additionalStats: {
          tradesCount: nonNegativeIntegerOrNull(row90D.trades_count),
          maxDrawdown: metric(row90D, 'max_drawdown'),
          sharpeRatio: metric(row90D, 'sharpe_ratio'),
          avgProfit: null,
          avgLoss: null,
          activeSince: null,
          avgHoldingTime: null,
        },
        frequentlyTraded: null,
      }
    : null

  return {
    performance,
    stats,
    rank90D: rankOrNull(row90D),
    arenaScore90D: metric(row90D, 'arena_score'),
    roi90D: metric(row90D, 'roi'),
    followers90D: nonNegativeIntegerOrNull(row90D?.followers),
    copiers90D: nonNegativeIntegerOrNull(row90D?.copiers),
    rankingVisibility: cohort.rankingVisibility,
    rankingVisibilityReason: cohort.rankingVisibilityReason,
  }
}

/**
 * Keep position identity/side/allocation visible, but never turn the old
 * helper's synthetic PnL/value/price zeroes into public measurements.
 */
export function sanitizePublicFullPortfolio(value: unknown): PublicLegacyRecord[] {
  if (!Array.isArray(value)) return []

  const safe: PublicLegacyRecord[] = []
  for (const position of value) {
    if (!isRecord(position)) return []
    const rawMarket = position.market ?? position.symbol
    const market = typeof rawMarket === 'string' && rawMarket.trim() ? rawMarket : null
    const direction =
      position.direction === 'long' || position.direction === 'short' ? position.direction : null
    const rawInvested = position.invested ?? position.invested_pct
    safe.push({
      market,
      direction,
      invested: finiteOrNull(rawInvested),
      pnl: null,
      value: null,
      price: null,
      priceChange: null,
      priceChangePct: null,
      coverage_state: 'unknown',
      coverage_reason: 'position_value_unverified',
    })
  }
  return safe
}

/**
 * `fetchSimilarTraders` has already queried and sanitized the sealed view.
 * This second narrow projection prevents an unexpected mapper payload from
 * introducing NaN, foreign identities, or raw-looking fallback values into
 * the legacy response.
 */
export function sanitizePublicFullSimilarTraders(
  value: unknown,
  expectedSource: string
): PublicLegacyRecord[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const safe: PublicLegacyRecord[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) return []
    const source = typeof candidate.platform === 'string' ? candidate.platform : null
    const traderKey = typeof candidate.traderKey === 'string' ? candidate.traderKey : null
    const rank = finiteOrNull(candidate.rank)
    const arenaScore = finiteOrNull(candidate.arenaScore)
    const roi = finiteOrNull(candidate.roi)
    const pnl = finiteOrNull(candidate.pnl)
    // Win rate and drawdown are optional on a ranked row: null/absent means
    // "not provided". A value that is present must still be a finite number.
    const winRateProvided = candidate.winRate !== null && candidate.winRate !== undefined
    const maxDrawdownProvided =
      candidate.maxDrawdown !== null && candidate.maxDrawdown !== undefined
    const winRate = finiteOrNull(candidate.winRate)
    const maxDrawdown = finiteOrNull(candidate.maxDrawdown)

    if (
      source !== expectedSource ||
      !traderKey ||
      seen.has(traderKey) ||
      rank === null ||
      !Number.isSafeInteger(rank) ||
      rank <= 0 ||
      arenaScore === null ||
      roi === null ||
      pnl === null ||
      (winRateProvided && winRate === null) ||
      (maxDrawdownProvided && maxDrawdown === null)
    ) {
      // Similar cards are an ordered recommendation slice. Do not omit a bad
      // member and shift a later candidate upward as though it were verified.
      return []
    }

    seen.add(traderKey)
    safe.push({
      handle:
        typeof candidate.handle === 'string' && candidate.handle.trim()
          ? candidate.handle
          : traderKey,
      id: traderKey,
      source,
      avatar_url: typeof candidate.avatarUrl === 'string' ? candidate.avatarUrl : null,
      followers: nonNegativeIntegerOrNull(candidate.followers),
      copiers: nonNegativeIntegerOrNull(candidate.copiers),
      trades_count: nonNegativeIntegerOrNull(candidate.tradesCount),
      roi_90d: roi,
      pnl,
      win_rate: winRate,
      max_drawdown: maxDrawdown,
      arena_score: arenaScore,
      rank,
    })
  }
  return safe
}
