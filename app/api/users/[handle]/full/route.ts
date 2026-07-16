/**
 * 用户主页聚合 API
 * 一次请求获取所有需要的数据，减少前端请求数
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import {
  getTraderByHandle,
  getTraderPerformance,
  getTraderStats,
  getTraderPortfolio,
} from '@/lib/data/trader'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { getOrSetWithLock } from '@/lib/cache'
import { readPublicProfileAudienceByHandle } from '@/lib/profile/public-audience'

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
    const [profileResult, audience] = await Promise.all([
      getTraderByHandle(handle),
      readPublicProfileAudienceByHandle(getSupabaseAdmin(), handle),
    ])

    if (audience.status === 'inactive') {
      return NextResponse.json(
        { error: 'User not found' },
        {
          status: 404,
          headers: { 'Cache-Control': 'private, no-store, max-age=0' },
        }
      )
    }

    // Unwrap DataResult: distinguish "not found" from "data layer error"
    const profile = profileResult?.ok ? profileResult.data : null
    const profileError = profileResult && !profileResult.ok ? profileResult.error : null

    if (!profile) {
      // If data layer failed (vs genuine not-found), return 502 so callers can distinguish
      if (profileError) {
        logger.error('[API] Data layer error fetching trader profile:', profileError)
        return NextResponse.json({ error: 'Data layer error' }, { status: 502 })
      }
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Route-level Redis cache — wraps all parallel DB queries with stampede protection
    const audienceIdentity =
      audience.status === 'active' ? `user:${audience.profile.id}` : 'unregistered'
    const traderIdentity = `${profile.source || 'unknown'}:${profile.id}`
    const cacheKey = `users-full:v3:${handle.toLocaleLowerCase('en-US')}:${audienceIdentity}:${traderIdentity}`
    const result = await getOrSetWithLock(
      cacheKey,
      async () => {
        // Phase 2: parallel-fetch everything else (including similarTraders now that we have profile.source)
        const [
          performanceResult,
          statsResult,
          portfolioResult,
          subscriptionData,
          similarTradersData,
        ] = await Promise.all([
          // 绩效数据 — log before degrading to null so a systemic failure
          // (e.g. schema drift in getTraderStats) is observable, not invisible.
          getTraderPerformance(handle, '90D').catch((e) => {
            logger.error('[users/full] getTraderPerformance failed', { handle, error: String(e) })
            return null
          }),
          // 统计数据
          getTraderStats(handle).catch((e) => {
            logger.error('[users/full] getTraderStats failed', { handle, error: String(e) })
            return null
          }),
          // 持仓数据
          getTraderPortfolio(handle).catch((e) => {
            logger.error('[users/full] getTraderPortfolio failed', { handle, error: String(e) })
            return null
          }),
          // 订阅状态 + 粉丝/关注缓存计数（如果是用户）
          // follower_count / following_count are cached columns kept in sync by
          // updateFollowCounts() on every follow/unfollow, so we read them
          // here instead of issuing two COUNT(*) queries on user_follows.
          (async () => {
            if (audience.status !== 'active') return null
            try {
              const { data } = await supabase
                .from('user_profiles')
                .select('subscription_tier, show_pro_badge, follower_count, following_count')
                .eq('id', audience.profile.id)
                .maybeSingle()
              return data
            } catch (e) {
              logger.error('[users/full] user_profiles counts query failed', {
                handle,
                error: String(e),
              })
              return null
            }
          })(),
          // 相似交易员 (runs in parallel now instead of sequentially)
          (async () => {
            if (!profile.source) return []
            const { data: similar } = await supabase
              .from('leaderboard_ranks')
              .select('source_trader_id, handle, source, roi, followers')
              .eq('source', profile.source)
              .eq('season_id', '90D')
              .neq('handle', handle)
              .not('arena_score', 'is', null)
              .order('arena_score', { ascending: false })
              .limit(5)
            return similar || []
          })(),
        ])

        const performance = performanceResult?.ok ? performanceResult.data : null
        const stats = statsResult?.ok ? statsResult.data : null
        const portfolio = portfolioResult?.ok ? portfolioResult.data : []
        const similarTraders = similarTradersData

        // 粉丝/关注数 — served from cached columns fetched above
        // (subscriptionData). Falls back to profile.followers (trader row)
        // for handles that don't have a user_profiles entry.
        return {
          profile: {
            ...profile,
            followers: subscriptionData?.follower_count ?? profile.followers ?? 0,
            following: subscriptionData?.following_count ?? 0,
            subscription_tier: subscriptionData?.subscription_tier || 'free',
            show_pro_badge: subscriptionData?.show_pro_badge ?? true,
          },
          performance,
          stats,
          portfolio,
          similarTraders,
          // Flag partial failures so UI can show appropriate indicators
          _errors: {
            performance:
              performanceResult && !performanceResult.ok ? performanceResult.error : undefined,
            stats: statsResult && !statsResult.ok ? statsResult.error : undefined,
            portfolio: portfolioResult && !portfolioResult.ok ? portfolioResult.error : undefined,
          },
          // 元信息
          meta: {
            timestamp: new Date().toISOString(),
            cached: false,
          },
        }
      },
      { ttl: 120 }
    ) // 2 min cache

    return NextResponse.json(result, {
      headers: {
        // Redis stores candidates, while every HTTP request re-checks current
        // account visibility above. Shared/CDN caching would bypass that check.
        'Cache-Control': 'private, no-store, max-age=0',
      },
    })
  } catch (error: unknown) {
    // Log server-side only; never expose internal details to client
    logger.error('[API] Error fetching user full data:', error)
    return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 })
  }
}
