import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankIdentities } from '@/lib/rankings/read-sealed-rank-identities'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import type { LeaderboardPublicationSeason } from '@/lib/rankings/read-publication-proofs'

const PERIOD_DAYS: Record<string, number> = {
  '7D': 7,
  '30D': 30,
  '90D': 90,
}
// Cache namespace is versioned because the original endpoint cached empty
// results produced by its retired raw-history query. Reusing that namespace
// after switching to the aggregate RPC can keep a repaired token board empty
// until the old Redis entry expires.
export const TOKEN_TRADER_RANKING_CACHE_VERSION = 'v4'

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

function finiteNumber(value: unknown, label: string): number {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'string' && value.trim().length === 0)
  ) {
    throw new Error(`${label} must be numeric`)
  }
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be finite`)
  return parsed
}

function nullableFiniteNumber(value: unknown, label: string): number | null {
  return value === null ? null : finiteNumber(value, label)
}

function parseAggregatedRows(input: unknown, offset: number): AggregatedTokenTrader[] {
  if (!Array.isArray(input)) {
    throw new Error('token trader ranking RPC returned no row array')
  }

  const rows: AggregatedTokenTrader[] = []
  const seen = new Set<string>()
  let expectedTotal: number | undefined

  for (const [index, value] of input.entries()) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`token trader ranking row ${index} is malformed`)
    }
    const row = value as Record<string, unknown>
    if (
      !isPublicRankingSourceAllowed(row.source) ||
      typeof row.source_trader_id !== 'string' ||
      row.source_trader_id.length === 0 ||
      row.source_trader_id.length > 500
    ) {
      throw new Error(`token trader ranking row ${index} has an invalid public identity`)
    }

    const tokenPnl = finiteNumber(row.token_pnl, `row ${index} token_pnl`)
    const tokenTradeCount = finiteNumber(row.token_trade_count, `row ${index} token_trade_count`)
    const tokenWinRate = nullableFiniteNumber(row.token_win_rate, `row ${index} token_win_rate`)
    const tokenAvgPnlPct = nullableFiniteNumber(
      row.token_avg_pnl_pct,
      `row ${index} token_avg_pnl_pct`
    )
    const totalCount = finiteNumber(row.total_count, `row ${index} total_count`)

    if (!Number.isSafeInteger(tokenTradeCount) || tokenTradeCount <= 0) {
      throw new Error(`row ${index} token_trade_count must be a positive safe integer`)
    }
    if (tokenWinRate !== null && (tokenWinRate < 0 || tokenWinRate > 100)) {
      throw new Error(`row ${index} token_win_rate must be between 0 and 100`)
    }
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new Error(`row ${index} total_count must be a non-negative safe integer`)
    }
    if (expectedTotal !== undefined && totalCount !== expectedTotal) {
      throw new Error('token trader ranking rows disagree on total_count')
    }
    expectedTotal ??= totalCount

    const identity = `${row.source}\u0000${row.source_trader_id}`
    if (seen.has(identity)) {
      throw new Error('token trader ranking RPC returned a duplicate identity')
    }
    seen.add(identity)
    rows.push({
      source: row.source as string,
      source_trader_id: row.source_trader_id,
      token_pnl: tokenPnl,
      token_trade_count: tokenTradeCount,
      token_win_rate: tokenWinRate,
      token_avg_pnl_pct: tokenAvgPnlPct,
      total_count: totalCount,
    })
  }

  if (rows.length > 0 && (expectedTotal ?? 0) < offset + rows.length) {
    throw new Error('token trader ranking total_count is smaller than the returned page')
  }
  return rows
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
  const season: LeaderboardPublicationSeason =
    period === '7D' || period === '30D' || period === '90D' ? period : '90D'
  const sealedPage = await readSealedRankingAuthorityGeneration(
    supabase,
    season,
    async (publication) => {
      const allowedSources = publication.proofs
        .map((proof) => proof.source)
        .filter(isPublicRankingSourceAllowed)
      if (allowedSources.length === 0) {
        throw new Error('token trader ranking publication has no public sources')
      }

      const { data, error } = await supabase.rpc('get_public_token_trader_rankings', {
        token_symbol: token,
        lookback_days: PERIOD_DAYS[season],
        max_traders: limit,
        row_offset: offset,
        allowed_sources: allowedSources,
      })
      if (error) throw new Error(error.message)

      const rows = parseAggregatedRows(data, offset)
      const allowedSourceSet = new Set(allowedSources)
      if (rows.some((row) => !allowedSourceSet.has(row.source))) {
        throw new Error('token trader ranking RPC returned a source outside publication authority')
      }
      if (rows.length === 0) return { traders: [], total: 0 }

      const sealedProfiles = await readSealedRankIdentities(
        supabase,
        season,
        rows.map((row) => ({
          source: row.source,
          sourceTraderId: row.source_trader_id,
        }))
      )
      if (!sealedProfiles) {
        throw new Error('token trader profiles had no public ranking authority')
      }

      return mergeTokenRankingsWithProfiles(rows, sealedProfiles.value)
    }
  )

  return sealedPage.value
}
