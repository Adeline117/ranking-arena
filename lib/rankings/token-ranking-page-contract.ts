import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import type { TokenTraderRanking } from '@/lib/rankings/token-traders'

export type TokenRankingPeriod = '7D' | '30D' | '90D'

export interface TokenRankingRequestIdentity {
  token: string
  period: TokenRankingPeriod
  limit: number
  offset: number
}

export interface TokenRankingPageReceipt extends TokenRankingRequestIdentity {
  traders: TokenTraderRanking[]
  total: number
}

const RECEIPT_KEYS = ['limit', 'offset', 'period', 'token', 'total', 'traders'] as const
const TRADER_KEYS = [
  'arena_score',
  'avatar_url',
  'handle',
  'roi',
  'source',
  'source_trader_id',
  'token_avg_pnl_pct',
  'token_pnl',
  'token_trade_count',
  'token_win_rate',
  'total_pnl',
] as const

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort()
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

/**
 * Parse an exact detail-page receipt. The four request dimensions are echoed
 * by the server so a successful HTTP response cannot be applied to a different
 * token, period, limit, or offset after navigation.
 */
export function parseTokenRankingPageReceipt(
  value: unknown,
  expected: TokenRankingRequestIdentity,
  allowedSources?: readonly string[]
): TokenRankingPageReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (!hasExactKeys(value, RECEIPT_KEYS)) return null

  const token = Reflect.get(value, 'token')
  const period = Reflect.get(value, 'period')
  const limit = Reflect.get(value, 'limit')
  const offset = Reflect.get(value, 'offset')
  const total = Reflect.get(value, 'total')
  const traders = Reflect.get(value, 'traders')
  if (
    token !== expected.token ||
    period !== expected.period ||
    limit !== expected.limit ||
    offset !== expected.offset ||
    !Number.isSafeInteger(total) ||
    Number(total) < 0 ||
    !Array.isArray(traders) ||
    traders.length > expected.limit ||
    (traders.length > 0 && Number(total) < expected.offset + traders.length)
  ) {
    return null
  }

  const allowedSourceSet = allowedSources ? new Set(allowedSources) : null
  const identities = new Set<string>()
  const parsed: TokenTraderRanking[] = []
  for (const trader of traders) {
    if (!trader || typeof trader !== 'object' || Array.isArray(trader)) return null
    if (!hasExactKeys(trader, TRADER_KEYS)) return null

    const source = Reflect.get(trader, 'source')
    const sourceTraderId = Reflect.get(trader, 'source_trader_id')
    const handle = Reflect.get(trader, 'handle')
    const avatarUrl = Reflect.get(trader, 'avatar_url')
    const arenaScore = Reflect.get(trader, 'arena_score')
    const roi = Reflect.get(trader, 'roi')
    const totalPnl = Reflect.get(trader, 'total_pnl')
    const tokenPnl = Reflect.get(trader, 'token_pnl')
    const tokenTradeCount = Reflect.get(trader, 'token_trade_count')
    const tokenWinRate = Reflect.get(trader, 'token_win_rate')
    const tokenAvgPnlPct = Reflect.get(trader, 'token_avg_pnl_pct')
    if (
      typeof source !== 'string' ||
      !isPublicRankingSourceAllowed(source) ||
      (allowedSourceSet !== null && !allowedSourceSet.has(source)) ||
      typeof sourceTraderId !== 'string' ||
      sourceTraderId.length === 0 ||
      sourceTraderId.length > 500 ||
      (handle !== null && typeof handle !== 'string') ||
      (avatarUrl !== null && typeof avatarUrl !== 'string') ||
      !isNullableFiniteNumber(arenaScore) ||
      (arenaScore !== null && (arenaScore < 0 || arenaScore > 100)) ||
      !isNullableFiniteNumber(roi) ||
      !isFiniteNumber(totalPnl) ||
      !isFiniteNumber(tokenPnl) ||
      !Number.isSafeInteger(tokenTradeCount) ||
      Number(tokenTradeCount) <= 0 ||
      !isNullableFiniteNumber(tokenWinRate) ||
      (tokenWinRate !== null && (tokenWinRate < 0 || tokenWinRate > 100)) ||
      !isNullableFiniteNumber(tokenAvgPnlPct)
    ) {
      return null
    }

    const identity = `${source}\u0000${sourceTraderId}`
    if (identities.has(identity)) return null
    identities.add(identity)
    parsed.push({
      source,
      source_trader_id: sourceTraderId,
      handle,
      avatar_url: avatarUrl,
      arena_score: arenaScore,
      roi,
      total_pnl: totalPnl,
      token_pnl: tokenPnl,
      token_trade_count: Number(tokenTradeCount),
      token_win_rate: tokenWinRate,
      token_avg_pnl_pct: tokenAvgPnlPct,
    })
  }

  return {
    token,
    period,
    limit,
    offset,
    traders: parsed,
    total: Number(total),
  }
}
