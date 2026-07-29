/**
 * Similar traders lookup — finds traders with comparable performance.
 * Queries leaderboard_ranks which uses v1 column names (source, source_trader_id, season_id).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { UnifiedTrader } from './types'
import { mapLeaderboardRow } from './mappers'
import { LR } from '@/lib/types/schema-mapping'
import { tieredGet, tieredSet } from '@/lib/cache/redis-layer'
import { logger } from '@/lib/logger'
import {
  filterPublicRankingSources,
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
} from '@/lib/rankings/publication-policy'
import {
  readSealedRankingGeneration,
  sealedRankingPublicationIdentity,
} from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

function parseCachedSimilarTraders(
  value: unknown,
  platform: string,
  traderKey: string
): UnifiedTrader[] | null {
  if (!Array.isArray(value) || value.length > 10) return null
  for (const trader of value) {
    if (
      trader === null ||
      typeof trader !== 'object' ||
      Reflect.get(trader, 'platform') !== platform ||
      Reflect.get(trader, 'period') !== '90D' ||
      typeof Reflect.get(trader, 'traderKey') !== 'string' ||
      Reflect.get(trader, 'traderKey') === traderKey
    ) {
      return null
    }
  }
  return value as UnifiedTrader[]
}

export async function fetchSimilarTraders(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null
): Promise<UnifiedTrader[]> {
  if (!isPublicRankingSourceAllowed(platform)) return []
  const proofSources = filterPublicRankingSources([platform])
  if (proofSources.length !== 1) return []

  // Bucket the score portion so small score changes do not churn a trader's key.
  const scoreBucket =
    arenaScore != null
      ? Math.round(arenaScore / 10) * 10
      : roi != null
        ? `roi${Math.round(roi / 50) * 50}`
        : 'none'
  // Include the excluded identity: sharing one bucket page across different
  // traders can otherwise return the current trader to themselves.
  const cacheKey = publicRankingCacheKey(
    `similar:sealed-v2:${platform}:${encodeURIComponent(traderKey)}:${scoreBucket}`
  )

  try {
    let cached: unknown = null
    try {
      cached = (await tieredGet<unknown>(cacheKey, 'warm')).data
    } catch {
      // Cache availability must not suppress a verifiable database read.
    }

    let reusedCache = false
    const sealedRead = await readSealedRankingGeneration(
      supabase,
      { season: '90D', sources: proofSources },
      async (publication) => {
        const cachedEntry = parseSealedRankingCacheEntry<UnifiedTrader[]>(
          cached,
          '90D',
          proofSources
        )
        if (
          cachedEntry &&
          cachedEntry.publicationIdentity === sealedRankingPublicationIdentity(publication)
        ) {
          const cachedTraders = parseCachedSimilarTraders(cachedEntry.value, platform, traderKey)
          if (cachedTraders) {
            reusedCache = true
            return cachedTraders
          }
        }
        return fetchSimilarTradersUncached(
          supabase,
          platform,
          traderKey,
          arenaScore,
          roi,
          publication.scoreCohortId
        )
      }
    )

    if (!reusedCache) {
      void tieredSet(cacheKey, createSealedRankingCacheEntry(sealedRead), 'warm', [
        'similar-traders',
      ]).catch((err) => {
        logger.warn(
          '[similar-traders] cache write failed:',
          err instanceof Error ? err.message : String(err)
        )
      })
    }
    return sealedRead.value
  } catch {
    // Proof or fetch error — fail closed rather than mixing generations.
    return []
  }
}

async function fetchSimilarTradersUncached(
  supabase: SupabaseClient,
  platform: string,
  traderKey: string,
  arenaScore: number | null,
  roi: number | null,
  scoreCohortId: string
): Promise<UnifiedTrader[]> {
  try {
    let data: Record<string, unknown>[] | null = null

    // leaderboard_ranks column mapping: source → platform, source_trader_id → traderKey, season_id → period
    if (arenaScore != null) {
      const scoreRange = Math.max(arenaScore * 0.25, 10)
      const result = await supabase
        .from('leaderboard_ranks')
        .select(
          `${LR.source}, ${LR.source_trader_id}, ${LR.handle}, ${LR.avatar_url}, ${LR.arena_score}, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown, followers, ${LR.rank}, ${LR.season_id}, source_type, trader_type, computed_at`
        )
        .eq(LR.source, platform)
        .eq(LR.season_id, '90D')
        .filter('rank_publication_id', 'eq', scoreCohortId)
        .neq(LR.source_trader_id, traderKey)
        .not(LR.arena_score, 'is', null)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .gte(LR.arena_score, arenaScore - scoreRange)
        .lte(LR.arena_score, arenaScore + scoreRange)
        .order(LR.arena_score, { ascending: false })
        .limit(10)
      if (result.error) throw new Error(result.error.message)
      data = result.data as Record<string, unknown>[] | null
    } else if (roi != null) {
      const roiRange = Math.max(Math.abs(roi) * 0.3, 20)
      const result = await supabase
        .from('leaderboard_ranks')
        .select(
          `${LR.source}, ${LR.source_trader_id}, ${LR.handle}, ${LR.avatar_url}, ${LR.arena_score}, ${LR.roi}, ${LR.pnl}, win_rate, max_drawdown, followers, ${LR.rank}, ${LR.season_id}, source_type, trader_type, computed_at`
        )
        .eq(LR.source, platform)
        .eq(LR.season_id, '90D')
        .filter('rank_publication_id', 'eq', scoreCohortId)
        .neq(LR.source_trader_id, traderKey)
        .or('is_outlier.is.null,is_outlier.eq.false')
        .gte(LR.roi, roi - roiRange)
        .lte(LR.roi, roi + roiRange)
        .order(LR.roi, { ascending: false })
        .limit(10)
      if (result.error) throw new Error(result.error.message)
      data = result.data as Record<string, unknown>[] | null
    }

    if (!data || data.length === 0) return []

    // Dedupe and map
    const seen = new Set<string>()
    return data
      .filter((row) => {
        if (!isPublicRankingSourceAllowed(row[LR.source])) return false
        const id = String(row[LR.source_trader_id] || '')
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .map((row) => mapLeaderboardRow(row))
  } catch (err) {
    logger.warn(
      '[similar-traders] lookup failed:',
      err instanceof Error ? err.message : String(err)
    )
    return []
  }
}
