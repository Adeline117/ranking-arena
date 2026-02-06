/**
 * 用户主页聚合 API
 * 一次请求获取所有需要的数据，减少前端请求数
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getTraderByHandle, getTraderPerformance, getTraderStats, getTraderPortfolio } from '@/lib/data/trader'

function getSupabase() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Supabase 环境变量未配置')
  }
  return createClient(url, key)
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ handle: string }> }
) {
  try {
    // 解析 params
    const params = await Promise.resolve(context.params)
    const handle = params.handle

    if (!handle) {
      return NextResponse.json({ error: 'Handle is required' }, { status: 400 })
    }

    // 并行获取所有数据
    const [
      profile,
      performance,
      stats,
      portfolio,
      subscriptionData,
    ] = await Promise.all([
      // 用户/交易员基本信息
      getTraderByHandle(handle),
      // 绩效数据
      getTraderPerformance(handle, '90D').catch(() => null),
      // 统计数据
      getTraderStats(handle).catch(() => null),
      // 持仓数据
      getTraderPortfolio(handle).catch(() => []),
      // 订阅状态（如果是用户）
      (async () => {
        try {
          const { data } = await getSupabase()
            .from('user_profiles')
            .select('subscription_tier, show_pro_badge')
            .eq('handle', handle)
            .maybeSingle()
          return data
        } catch {
          return null
        }
      })(),
    ])

    if (!profile) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    // 获取相似交易员
    let similarTraders: Array<{ id: string; handle: string; source: string; roi_90d?: number; followers?: number }> = []
    if (profile.source) {
      const { data: similar } = await getSupabase()
        .from('traders')
        .select('id, handle, source, roi_90d, followers')
        .eq('source', profile.source)
        .neq('handle', handle)
        .order('roi_90d', { ascending: false })
        .limit(5)
      
      similarTraders = similar || []
    }

    // 获取粉丝和关注数
    const [followersResult, followingResult] = await Promise.all([
      getSupabase()
        .from('user_follows')
        .select('id', { count: 'exact', head: true })
        .eq('following_id', profile.id),
      getSupabase()
        .from('user_follows')
        .select('id', { count: 'exact', head: true })
        .eq('follower_id', profile.id),
    ])

    // 构建响应
    const response = {
      profile: {
        ...profile,
        followers: followersResult.count || profile.followers || 0,
        following: followingResult.count || 0,
        subscription_tier: subscriptionData?.subscription_tier || 'free',
        show_pro_badge: subscriptionData?.show_pro_badge ?? true,
      },
      performance,
      stats,
      portfolio,
      similarTraders,
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
    console.error('[API] Error fetching user full data:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
