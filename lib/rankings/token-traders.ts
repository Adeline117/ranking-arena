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
export const TOKEN_TRADER_RANKING_CACHE_VERSION = 'v2'

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
  total_pnl: number
  token_pnl: number
  token_trade_count: number
  token_win_rate: number | null
  token_avg_pnl_pct: number | null
}

export interface TokenTraderRankingPage {
  traders: TokenTraderRanking[]
  total: number
}

function nullableNumber(value: number | string | null | undefined): number | null {
  return value == null ? null : Number(value)
}

export function mergeTokenRankingsWithProfiles(
  rows: AggregatedTokenTrader[],
  profiles: LeaderboardProfile[]
): TokenTraderRankingPage {
  const profileMap = new Map(
    profiles.map((profile) => [`${profile.source}:${profile.source_trader_id}`, profile])
  )

  return {
    total: rows.length > 0 ? Number(rows[0].total_count) : 0,
    traders: rows.map((row) => {
      const profile = profileMap.get(`${row.source}:${row.source_trader_id}`)
      return {
        source: row.source,
        source_trader_id: row.source_trader_id,
        handle: profile?.handle ?? null,
        avatar_url: profile?.avatar_url ?? null,
        arena_score: profile?.arena_score ?? null,
        roi: profile?.roi ?? null,
        total_pnl: profile?.pnl != null ? Number(profile.pnl) : 0,
        token_pnl: Number(row.token_pnl),
        token_trade_count: Number(row.token_trade_count),
        token_win_rate: nullableNumber(row.token_win_rate),
        token_avg_pnl_pct: nullableNumber(row.token_avg_pnl_pct),
      }
    }),
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
