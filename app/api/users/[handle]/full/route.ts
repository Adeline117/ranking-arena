/**
 * 用户主页聚合 API
 * 一次请求获取所有需要的数据，减少前端请求数
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getTraderDetail, resolveTrader, toTraderPageData } from '@/lib/data/unified'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import { readSealedRankingGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

export async function GET(request: NextRequest, context: { params: Promise<{ handle: string }> }) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResp) return rateLimitResp

  try {
    // 解析 params
    const params = await Promise.resolve(context.params)
    let handle: string
    try {
      handle = decodeURIComponent(params.handle)
    } catch {
      return NextResponse.json({ error: 'Invalid handle' }, { status: 400 })
    }

    if (!handle || handle.length > 200) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

    // Trader handles can exist without an app account. When an app profile is
    // present, however, service_role must prove that its current account state
    // is publicly visible before any cached profile-owned data may be returned.
    const [resolved, audience] = await Promise.all([
      resolveTrader(supabase, { handle }),
      readPublicProfileAudienceByHandle(getSupabaseAdmin(), handle),
    ])

    if (audience.status === 'inactive') {
      return NextResponse.json(
        { error: 'User not found' },
        {
          status: 404,
          headers: NO_STORE_HEADERS,
        }
      )
    }

    if (!resolved) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const profile = {
      handle: resolved.handle || resolved.traderKey,
      id: resolved.traderKey,
      bio: undefined as string | undefined,
      followers: 0,
      copiers: 0,
      avatar_url: resolved.avatarUrl || undefined,
      cover_url: undefined as string | undefined,
      isRegistered: audience.status === 'active',
      source: resolved.platform,
    }

    const publicRankingSource =
      profile.source && isPublicRankingSourceAllowed(profile.source) ? profile.source : null
    const traderId = profile.id

    async function readSubscriptionProfile() {
      if (audience.status !== 'active') return null
      const subscriptionResult = await supabase
        .from('user_profiles')
        .select(
          'subscription_tier, show_pro_badge, follower_count, following_count, bio, avatar_url, cover_url'
        )
        .eq('id', audience.profile.id)
        .maybeSingle()
      if (subscriptionResult.error) {
        throw new Error(`subscription profile query failed: ${subscriptionResult.error.message}`)
      }
      if (subscriptionResult.data == null) {
        throw new Error('subscription profile query returned no active profile')
      }
      return subscriptionResult.data
    }

    async function readSimilarTraders() {
      if (!publicRankingSource) return []
      const sealedRead = await readSealedRankingGeneration(
        supabase,
        { season: '90D', sources: [publicRankingSource] },
        async (publication) => {
          const similarResult = await supabase
            .from('leaderboard_ranks')
            .select('source_trader_id, handle, source, roi, followers, season_id')
            .eq('source', publicRankingSource)
            .eq('season_id', '90D')
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .neq('source_trader_id', traderId)
            .not('arena_score', 'is', null)
            .order('arena_score', { ascending: false })
            .limit(5)
          if (similarResult.error) {
            throw new Error(`similar traders query failed: ${similarResult.error.message}`)
          }
          if (!Array.isArray(similarResult.data)) {
            throw new Error('similar traders query returned an ambiguous payload')
          }
          return similarResult.data.filter(
            (row) =>
              row.source === publicRankingSource &&
              row.season_id === '90D' &&
              row.source_trader_id !== traderId
          )
        },
        { timeoutMs: 15_000 }
      )
      return sealedRead.value
    }

    async function readSealedCore() {
      if (!publicRankingSource) {
        return {
          profile,
          performance: null,
          stats: null,
          portfolio: [],
          _errors: {
            performance: 'ranking_source_not_public',
            stats: 'ranking_source_not_public',
          },
          meta: { timestamp: new Date().toISOString(), cached: false },
        }
      }

      const detail = await getTraderDetail(supabase, {
        platform: publicRankingSource,
        traderKey: traderId,
      })
      if (!detail) {
        throw new Error('sealed trader detail returned no data')
      }
      const pageData = toTraderPageData(detail)
      return {
        profile,
        performance: pageData.performance ?? null,
        stats: pageData.stats ?? null,
        portfolio: Array.isArray(pageData.portfolio) ? pageData.portfolio : [],
        _errors: {},
        meta: { timestamp: new Date().toISOString(), cached: false },
      }
    }

    // Account state and all ranking-derived values are request-time authority.
    // A generic aggregate cache cannot prove that all three detail windows are
    // still current after a publication cutover.
    const [core, subscriptionData, similarTraders] = await Promise.all([
      readSealedCore(),
      readSubscriptionProfile(),
      readSimilarTraders(),
    ])

    const result = {
      ...core,
      profile: {
        ...core.profile,
        bio: subscriptionData?.bio ?? profile.bio,
        avatar_url: subscriptionData?.avatar_url ?? profile.avatar_url,
        cover_url: subscriptionData?.cover_url ?? profile.cover_url,
        followers: subscriptionData?.follower_count ?? profile.followers ?? 0,
        following: subscriptionData?.following_count ?? 0,
        subscription_tier: subscriptionData?.subscription_tier || 'free',
        show_pro_badge: subscriptionData?.show_pro_badge ?? true,
      },
      similarTraders,
    }

    return NextResponse.json(result, {
      // Every request re-checks current account and publication authority.
      // Shared/CDN caching would bypass both checks.
      headers: NO_STORE_HEADERS,
    })
  } catch (error: unknown) {
    // Log server-side only; never expose internal details to client
    logger.error('[API] Error fetching user full data:', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
