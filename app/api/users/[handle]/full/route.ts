/**
 * 用户主页聚合 API
 * 一次请求获取所有需要的数据，减少前端请求数
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getTraderByHandle, getTraderPerformance, getTraderStats, getTraderPortfolio } from '@/lib/data/trader'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ handle: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.read)
  if (rateLimitResp) return rateLimitResp

  try {
    // 解析 params
    const params = await Promise.resolve(context.params)
    const handle = params.handle

    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    // Phase 1: fetch profile first (needed for similarTraders source filter)
    const profileResult = await getTraderByHandle(handle)

    // Unwrap DataResult: distinguish "not found" from "data layer error"
    const profile = profileResult?.ok ? profileResult.data : null
    const profileError = profileResult && !profileResult.ok ? profileResult.error : null

    if (!profile) {
      // If data layer failed (vs genuine not-found), return 502 so callers can distinguish
      if (profileError) {
        logger.error('[API] Data layer error fetching trader profile:', profileError)
        return NextResponse.json({ error: 'Data layer error', detail: profileError }, { status: 502 })
      }
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // Phase 2: parallel-fetch everything else (including similarTraders now that we have profile.source)
    const [
      performanceResult,
      statsResult,
      portfolioResult,
      subscriptionData,
      similarTradersData,
    ] = await Promise.all([
      // 绩效数据
      getTraderPerformance(handle, '90D').catch(() => null),
      // 统计数据
      getTraderStats(handle).catch(() => null),
      // 持仓数据
      getTraderPortfolio(handle).catch(() => null),
      // 订阅状态 + 粉丝/关注缓存计数（如果是用户）
      // follower_count / following_count are cached columns kept in sync by
      // updateFollowCounts() on every follow/unfollow, so we read them
      // here instead of issuing two COUNT(*) queries on user_follows.
      (async () => {
        try {
          const { data } = await getSupabaseAdmin()
            .from('user_profiles')
            .select('subscription_tier, show_pro_badge, follower_count, following_count')
            .eq('handle', handle)
            .maybeSingle()
          return data
        } catch {
          return null
        }
      })(),
      // 相似交易员 (runs in parallel now instead of sequentially)
      (async () => {
        if (!profile.source) return []
        const { data: similar } = await getSupabaseAdmin()
          .from('traders')
          .select('id, handle, source, roi_90d, followers')
          .eq('source', profile.source)
          .neq('handle', handle)
          .order('roi_90d', { ascending: false })
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
    const response = {
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
        performance: performanceResult && !performanceResult.ok ? performanceResult.error : undefined,
        stats: statsResult && !statsResult.ok ? statsResult.error : undefined,
        portfolio: portfolioResult && !portfolioResult.ok ? portfolioResult.error : undefined,
      },
      // 元信息
      meta: {
        timestamp: new Date().toISOString(),
        cached: false,
      },
    }

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    })
  } catch (error: unknown) {
    // Log server-side only; never expose internal details to client
    logger.error('[API] Error fetching user full data:', error)
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    )
  }
}
