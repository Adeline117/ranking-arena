/**
 * Top Traders API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { del, getOrSetWithLock } from '@/lib/cache'
import {
  isPublicRankingSourceAllowed,
  publicRankingCacheKey,
  sanitizePublicRankingSourcePayload,
} from '@/lib/rankings/publication-policy'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'
import {
  createSealedRankingCacheEntry,
  parseSealedRankingCacheEntry,
} from '@/lib/rankings/sealed-ranking-cache'

export const runtime = 'edge'
export const dynamic = 'force-dynamic'
export const revalidate = 0
const SIDEBAR_SEASON = '90D' as const
const RANKING_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

export const GET = withPublic(
  async () => {
    const cacheKey = publicRankingCacheKey('sidebar:top-traders-sealed-v3:90D')
    const supabase = getReadReplica()
    const fetchSealedEntry = async () => {
      const sealedRead = await readSealedRankingAuthorityGeneration(
        supabase,
        SIDEBAR_SEASON,
        async (publication) => {
          const authoritySources = publication.proofs.map((proof) => proof.source)
          // Fetch top 50 to diversify across exchanges (avoid showing only 1-2 exchanges)
          const { data: snapData, error: snapErr } = await supabase
            .from('leaderboard_ranks')
            .select('source, source_trader_id, handle, avatar_url, roi, pnl, arena_score')
            .eq('season_id', SIDEBAR_SEASON)
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .in('source', authoritySources)
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
          if (snapData.some((row) => !isPublicRankingSourceAllowed(row.source))) {
            throw new Error('sidebar ranking query crossed the public source boundary')
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

    const readAuthorizedCache = async () => {
      const cached = await getOrSetWithLock<unknown>(cacheKey, fetchSealedEntry, {
        ttl: 300,
        lockTtl: 10,
      })
      const sealedCache = parseSealedRankingCacheEntry<{ traders: unknown[] }>(
        cached,
        SIDEBAR_SEASON
      )
      if (!sealedCache) return null

      const currentGeneration = await readSealedRankingAuthorityGeneration(
        supabase,
        SIDEBAR_SEASON,
        async () => null,
        { timeoutMs: 10_000 }
      )
      return currentGeneration.publicationIdentity === sealedCache.publicationIdentity
        ? sealedCache
        : null
    }

    let sealedCache = await readAuthorizedCache()
    if (!sealedCache) {
      await del(cacheKey)
      sealedCache = await readAuthorizedCache()
    }
    if (!sealedCache || !Array.isArray(sealedCache.value.traders)) {
      throw new Error('sidebar cache did not satisfy the sealed publication contract')
    }

    return NextResponse.json(sanitizePublicRankingSourcePayload(sealedCache.value), {
      headers: RANKING_NO_STORE_HEADERS,
    })
  },
  { name: 'sidebar-top-traders', rateLimit: 'read' }
)
