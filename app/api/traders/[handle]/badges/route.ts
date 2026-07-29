import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/api'
import { resolveTrader } from '@/lib/data/unified'
import { calculateBadges, type EarnedBadge } from '@/lib/badges'
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

/**
 * GET /api/traders/[handle]/badges
 *
 * Returns all badges earned by a trader based on their current stats.
 */
function isBadgeResponse(value: unknown): value is { badges: EarnedBadge[] } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const badges = Reflect.get(value, 'badges')
  if (!Array.isArray(badges) || badges.length > 1) return false
  return badges.every((badge) => {
    if (
      badge === null ||
      typeof badge !== 'object' ||
      Array.isArray(badge) ||
      Reflect.get(badge, 'id') !== 'top10'
    ) {
      return false
    }
    const metadata = Reflect.get(badge, 'metadata')
    const rank =
      metadata !== null && typeof metadata === 'object' ? Reflect.get(metadata, 'rank') : null
    return Number.isSafeInteger(rank) && Number(rank) >= 1 && Number(rank) <= 10
  })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse
  const { handle } = await params

  if (!handle) {
    return NextResponse.json({ error: 'Handle required' }, { status: 400 })
  }

  const cacheHeaders = { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600' }

  const supabase = getSupabaseAdmin()

  // Resolve trader via unified layer
  const resolved = await resolveTrader(supabase, { handle })
  if (!resolved) {
    return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
  }
  if (!isPublicRankingSourceAllowed(resolved.platform)) {
    return NextResponse.json({ badges: [] }, { headers: cacheHeaders })
  }
  const proofSources = filterPublicRankingSources([resolved.platform])
  if (proofSources.length !== 1) {
    return NextResponse.json({ badges: [] }, { headers: cacheHeaders })
  }

  const cacheKey = publicRankingCacheKey(
    `badges:sealed-v2:${resolved.platform}:${encodeURIComponent(resolved.traderKey)}`
  )
  let cached: unknown = null
  try {
    cached = (await tieredGet<unknown>(cacheKey, 'warm')).data
  } catch (cacheError) {
    logger.warn(
      '[badges] cache read failed:',
      cacheError instanceof Error ? cacheError.message : String(cacheError)
    )
  }

  let reusedCache = false
  const sealedRead = await readSealedRankingGeneration(
    supabase,
    { season: '90D', sources: proofSources },
    async (publication) => {
      const cachedEntry = parseSealedRankingCacheEntry<{ badges: EarnedBadge[] }>(
        cached,
        '90D',
        proofSources
      )
      if (
        cachedEntry &&
        cachedEntry.publicationIdentity === sealedRankingPublicationIdentity(publication) &&
        isBadgeResponse(cachedEntry.value)
      ) {
        reusedCache = true
        return cachedEntry.value
      }

      const { data: rankData, error } = await supabase
        .from('leaderboard_ranks')
        .select('source_trader_id, rank, source, season_id')
        .eq('source', resolved.platform)
        .eq('source_trader_id', resolved.traderKey)
        .eq('season_id', '90D')
        .filter('rank_publication_id', 'eq', publication.scoreCohortId)
        .maybeSingle()
      if (error) throw new Error(`badge rank query failed: ${error.message}`)
      if (!rankData) return { badges: [] }
      if (
        rankData.source !== resolved.platform ||
        rankData.source_trader_id !== resolved.traderKey ||
        rankData.season_id !== '90D'
      ) {
        throw new Error('badge rank query escaped its identity scope')
      }

      return {
        badges: calculateBadges({
          handle: rankData.source_trader_id,
          rank: rankData.rank ?? 999999,
        }),
      }
    },
    { timeoutMs: 10_000 }
  )

  if (!reusedCache) {
    try {
      await tieredSet(cacheKey, createSealedRankingCacheEntry(sealedRead), 'warm')
    } catch (cacheError) {
      logger.warn(
        '[badges] cache write failed:',
        cacheError instanceof Error ? cacheError.message : String(cacheError)
      )
    }
  }
  return NextResponse.json(sealedRead.value, { headers: cacheHeaders })
}
