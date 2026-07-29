/**
 * Top Traders API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { del, getOrSetWithLock } from '@/lib/cache'
import {
  filterPublicRankingSources,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import { PUBLIC_ACTIVE_RANKING_SOURCES } from '@/lib/constants/exchanges'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

export const runtime = 'edge'
const SIDEBAR_RANKING_SOURCES = Object.freeze(
  filterPublicRankingSources(PUBLIC_ACTIVE_RANKING_SOURCES)
)
const SIDEBAR_SEASON = '90D' as const

export const GET = withPublic(
  async () => {
    const cacheKey = publicRankingCacheKey('sidebar:top-traders-sealed-v2:90D')
    const fetchSealedEntry = async () => {
      const supabase = getReadReplica()
      const sealedRead = await readSealedRankingGeneration(
        supabase,
        { season: SIDEBAR_SEASON, sources: SIDEBAR_RANKING_SOURCES },
        async (publication) => {
          // Fetch top 50 to diversify across exchanges (avoid showing only 1-2 exchanges)
          const { data: snapData, error: snapErr } = await supabase
            .from('leaderboard_ranks')
            .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score')
            .eq('season_id', SIDEBAR_SEASON)
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .in('source', SIDEBAR_RANKING_SOURCES)
            .not('arena_score', 'is', null)
            .gt('arena_score', 50)
            .or('is_outlier.is.null,is_outlier.eq.false')
            .order('arena_score', { ascending: false })
            .order('source', { ascending: true })
            .order('source_trader_id', { ascending: true })
            .limit(50)

          if (snapErr || snapData === null) {
            throw new Error(`sidebar cohort query failed: ${snapErr?.message ?? 'null payload'}`)
          }
          if (
            snapData.length === 0 &&
            publication.proofs.some((proof) => proof.published_rank_count > 0)
          ) {
            throw new Error('sidebar cohort query returned no rows for a non-empty publication')
          }

          // Diversify: pick top 1 per exchange first, then fill remaining slots by score
          const perExchange = new Map<string, (typeof snapData)[0]>()
          const rest: typeof snapData = []
          for (const row of snapData) {
            if (!perExchange.has(row.source)) {
              perExchange.set(row.source, row)
            } else {
              rest.push(row)
            }
          }
          const diverse = [...perExchange.values()].sort(
            (a, b) => (b.arena_score ?? 0) - (a.arena_score ?? 0)
          )
          const traders = [...diverse, ...rest].slice(0, 10).map((row) => ({
            source: row.source,
            source_trader_id: row.source_trader_id,
            handle: row.handle || null,
            avatar_url: row.avatar_url || null,
            roi: row.roi,
            arena_score: row.arena_score,
          }))

          return { traders }
        },
        { timeoutMs: 10_000 }
      )
      return createSealedRankingCacheEntry(sealedRead)
    }

    let cached = await getOrSetWithLock<unknown>(cacheKey, fetchSealedEntry, {
      ttl: 300,
      lockTtl: 10,
    })
    let sealedCache = parseSealedRankingCacheEntry<{ traders: unknown[] }>(
      cached,
      SIDEBAR_SEASON,
      SIDEBAR_RANKING_SOURCES
    )
    if (!sealedCache) {
      await del(cacheKey)
      cached = await getOrSetWithLock<unknown>(cacheKey, fetchSealedEntry, {
        ttl: 300,
        lockTtl: 10,
      })
      sealedCache = parseSealedRankingCacheEntry<{ traders: unknown[] }>(
        cached,
        SIDEBAR_SEASON,
        SIDEBAR_RANKING_SOURCES
      )
    }
    if (!sealedCache || !Array.isArray(sealedCache.value.traders)) {
      throw new Error('sidebar cache did not satisfy the sealed publication contract')
    }

    const response = NextResponse.json(sanitizePublicRankingSourcePayload(sealedCache.value))
    response.headers.set('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600')
    return response
  },
  { name: 'sidebar-top-traders', rateLimit: 'read' }
)
