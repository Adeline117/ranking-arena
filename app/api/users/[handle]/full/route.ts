/**
 * 用户主页聚合 API
 * 一次请求获取所有需要的数据，减少前端请求数
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'
import {
  fetchPublicProfileRankingRows,
  PUBLIC_PROFILE_RANKING_PERIODS,
} from '@/lib/data/trader/public-profile-ranking'
import {
  projectPublicFullProfileRanking,
  fetchPublicFullTraderIdentity,
  sanitizePublicFullSimilarTraders,
} from '@/lib/data/trader/public-full-profile'
import { fetchSimilarTraders } from '@/lib/data/trader/similar'

export const dynamic = 'force-dynamic'
export const revalidate = 0

const PUBLIC_PROFILE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
  Pragma: 'no-cache',
} as const

// `trader_portfolio` is an internal raw source. A service-role route must not
// turn its allocation/cost-basis-adjacent observations into a public API just
// because the direct browser ACL is sealed.
const LEGACY_PORTFOLIO_PUBLICATION_UNAVAILABLE = 'legacy_metric_publication_unavailable'

function exactSocialCountOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

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
      return NextResponse.json(
        { error: 'Invalid handle' },
        { status: 400, headers: PUBLIC_PROFILE_NO_STORE_HEADERS }
      )
    }

    if (!handle || handle.length > 200) {
      return NextResponse.json(
        { error: 'Handle is required' },
        { status: 400, headers: PUBLIC_PROFILE_NO_STORE_HEADERS }
      )
    }

    const supabase = getSupabaseAdmin()

    // Trader handles can exist without an app account. When an app profile is
    // present, however, service_role must prove that its current account state
    // is publicly visible before any profile-owned data may be returned.
    const [identityResult, audience] = await Promise.all([
      fetchPublicFullTraderIdentity(supabase, handle),
      readPublicProfileAudienceByHandle(getSupabaseAdmin(), handle),
    ])

    if (audience.status === 'inactive') {
      return NextResponse.json(
        { error: 'User not found' },
        {
          status: 404,
          headers: PUBLIC_PROFILE_NO_STORE_HEADERS,
        }
      )
    }

    if (!identityResult.identity) {
      if (identityResult.reason === 'trader_identity_unavailable') {
        logger.error('[users/full] trader identity query unavailable', { handle })
        return NextResponse.json(
          { error: 'Data layer error' },
          { status: 502, headers: PUBLIC_PROFILE_NO_STORE_HEADERS }
        )
      }
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404, headers: PUBLIC_PROFILE_NO_STORE_HEADERS }
      )
    }
    const profile = identityResult.identity

    // Rank-bearing fields must observe the serving-head view for this request.
    // Do not cache this aggregate: a cache hit cannot prove that a row remains
    // published after a source freshness or completeness change.
    const [rankingCohort, subscriptionData] = await Promise.all([
      fetchPublicProfileRankingRows(supabase, {
        source: profile.source,
        sourceTraderId: profile.id,
        periods: PUBLIC_PROFILE_RANKING_PERIODS,
      }),
      (async () => {
        if (audience.status !== 'active') return null
        try {
          const { data, error } = await supabase
            .from('user_profiles')
            .select(
              'subscription_tier, show_pro_badge, follower_count, following_count, bio, avatar_url, cover_url'
            )
            .eq('id', audience.profile.id)
            .maybeSingle()
          if (error) throw error
          return data
        } catch (error) {
          logger.error('[users/full] user_profiles counts query failed', {
            handle,
            error: String(error),
          })
          return null
        }
      })(),
    ])

    const ranking = projectPublicFullProfileRanking(rankingCohort)
    const similarTraders =
      ranking.rank90D !== null
        ? sanitizePublicFullSimilarTraders(
            await fetchSimilarTraders(
              supabase,
              profile.source,
              profile.id,
              ranking.arenaScore90D,
              ranking.roi90D
            ),
            profile.source
          )
        : []
    const portfolio: never[] = []

    const result = {
      profile: {
        // Identity/profile observations can remain public even when no ranking
        // cohort is currently available. Follower/copier values are kept out
        // of this fresh identity object and are supplied only below.
        handle: profile.handle,
        id: profile.id,
        bio: typeof subscriptionData?.bio === 'string' ? subscriptionData.bio : null,
        avatar_url:
          typeof subscriptionData?.avatar_url === 'string'
            ? subscriptionData.avatar_url
            : profile.avatarUrl,
        cover_url:
          typeof subscriptionData?.cover_url === 'string' ? subscriptionData.cover_url : null,
        isRegistered: audience.status === 'active',
        source: profile.source,
        followers: exactSocialCountOrNull(subscriptionData?.follower_count) ?? ranking.followers90D,
        following: exactSocialCountOrNull(subscriptionData?.following_count),
        copiers: ranking.copiers90D,
        subscription_tier:
          typeof subscriptionData?.subscription_tier === 'string'
            ? subscriptionData.subscription_tier
            : 'free',
        show_pro_badge:
          typeof subscriptionData?.show_pro_badge === 'boolean'
            ? subscriptionData.show_pro_badge
            : true,
      },
      performance: ranking.performance,
      stats: ranking.stats,
      portfolio,
      similarTraders,
      ranking_visibility: ranking.rankingVisibility,
      ranking_visibility_reason: ranking.rankingVisibilityReason,
      ranking_visibility_reasons: ranking.rankingVisibilityReason
        ? [ranking.rankingVisibilityReason]
        : [],
      // Flag unavailable evidence rather than manufacturing a zero-valued
      // performance/statistics payload for legacy callers.
      _errors: {
        performance:
          ranking.rankingVisibility === 'verified' ? undefined : ranking.rankingVisibilityReason,
        stats:
          ranking.rankingVisibility === 'verified' ? undefined : ranking.rankingVisibilityReason,
        portfolio: LEGACY_PORTFOLIO_PUBLICATION_UNAVAILABLE,
      },
      meta: {
        timestamp: new Date().toISOString(),
        cached: false,
      },
    }

    return NextResponse.json(result, {
      headers: PUBLIC_PROFILE_NO_STORE_HEADERS,
    })
  } catch (error: unknown) {
    // Log server-side only; never expose internal details to client
    logger.error('[API] Error fetching user full data:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500, headers: PUBLIC_PROFILE_NO_STORE_HEADERS }
    )
  }
}
