import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'

const PERIOD_DAYS: Record<string, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}

// Cache namespace is versioned because the original endpoint cached empty
// results produced by its retired raw-history query. Reusing that namespace
// after switching to the aggregate RPC can keep a repaired token board empty
// until the old Redis entry expires.
export const TOKEN_TRADER_RANKING_CACHE_VERSION = 'v3'

export function getTokenTraderRankingCacheKey(
  token: string,
  period: string,
  limit: number,
  offset: number
): string {
  return `rankings:by-token:${TOKEN_TRADER_RANKING_CACHE_VERSION}:${token}:${period}:${limit}:${offset}`
}

interface AggregatedTokenTrader {
  source: string
  source_trader_id: string
  token_rank: number | string | null
  token_pnl: number | string
  token_trade_count: number | string
  token_win_rate: number | string | null
  token_avg_pnl_pct: number | string | null
  total_count: number | string
}

interface LeaderboardProfile {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
}

export interface TokenTraderRanking {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  total_pnl: number | null
  token_rank: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
}

export interface TokenTraderRankingPage {
  traders: TokenTraderRanking[]
  total: number
}

function traderIdentityKey(source: string, sourceTraderId: string): string {
  return JSON.stringify([source, sourceTraderId])
}

function finiteNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && value.trim().length === 0) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function safeIntegerOrNull(value: unknown, minimum: number): number | null {
  const parsed = finiteNumberOrNull(value)
  return parsed !== null && Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null
}

export function mergeTokenRankingsWithProfiles(
  rows: AggregatedTokenTrader[],
  profiles: LeaderboardProfile[]
): TokenTraderRankingPage {
  const profileMap = new Map(
    profiles.map((profile) => [
      traderIdentityKey(profile.source, profile.source_trader_id),
      profile,
    ])
  )
  if (rows.length === 0) return { traders: [], total: 0 }

  const total = safeIntegerOrNull(rows[0]?.total_count, 0)
  if (total === null) throw new Error('Token ranking response contained an invalid total')

  const seenRanks = new Set<number>()
  const seenIdentities = new Set<string>()
  const traders: TokenTraderRanking[] = []
  let previousRank: number | null = null

  for (const row of rows) {
    const rank = safeIntegerOrNull(row.token_rank, 1)
    const rowTotal = safeIntegerOrNull(row.total_count, 0)
    const tokenPnl = finiteNumberOrNull(row.token_pnl)
    const tokenTradeCount = safeIntegerOrNull(row.token_trade_count, 0)
    if (
      typeof row.source !== 'string' ||
      row.source.trim().length === 0 ||
      typeof row.source_trader_id !== 'string' ||
      row.source_trader_id.trim().length === 0 ||
      rank === null ||
      rowTotal === null ||
      rowTotal !== total ||
      rank > total ||
      tokenPnl === null ||
      tokenTradeCount === null
    ) {
      throw new Error('Token ranking response violated its authority contract')
    }

    const identity = traderIdentityKey(row.source, row.source_trader_id)
    if (
      seenRanks.has(rank) ||
      seenIdentities.has(identity) ||
      (previousRank !== null && rank !== previousRank + 1)
    ) {
      throw new Error('Token ranking response violated its ordering contract')
    }
    const profile = profileMap.get(identity)
    const tokenWinRate = finiteNumberOrNull(row.token_win_rate)
    const arenaScore = finiteNumberOrNull(profile?.arena_score)
    seenRanks.add(rank)
    seenIdentities.add(identity)
    previousRank = rank
    traders.push({
      source: row.source,
      source_trader_id: row.source_trader_id,
      handle: profile?.handle ?? null,
      avatar_url: profile?.avatar_url ?? null,
      arena_score: arenaScore !== null && arenaScore >= 0 && arenaScore <= 100 ? arenaScore : null,
      roi: finiteNumberOrNull(profile?.roi),
      total_pnl: finiteNumberOrNull(profile?.pnl),
      token_rank: rank,
      token_pnl: tokenPnl,
      token_trade_count: tokenTradeCount,
      token_win_rate:
        tokenWinRate !== null && tokenWinRate >= 0 && tokenWinRate <= 100 ? tokenWinRate : null,
      token_avg_pnl_pct: finiteNumberOrNull(row.token_avg_pnl_pct),
    })
  }

  return {
    total,
    traders,
  }
}

export async function getTokenTraderRankings(
  supabase: SupabaseClient<Database>,
  token: string,
  period: string,
  limit: number,
  offset: number
): Promise<TokenTraderRankingPage> {
  const { data, error } = await supabase.rpc('get_token_trader_rankings', {
    token_symbol: token,
    lookback_days: PERIOD_DAYS[period] || 90,
    max_traders: limit,
    row_offset: offset,
  })

  if (error) throw new Error(error.message)

  const rows = (data || []) as AggregatedTokenTrader[]
  if (rows.length === 0) return { traders: [], total: 0 }

  const traderIds = rows.map((row) => row.source_trader_id)
  const { data: profileData } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl')
    .eq('season_id', period)
    .in('source_trader_id', traderIds)

  return mergeTokenRankingsWithProfiles(rows, (profileData || []) as LeaderboardProfile[])
}
