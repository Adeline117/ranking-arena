/**
 * 每日活动统计 API
 * GET /api/analytics/activity - 返回今日用户活动数据（供每日 Telegram 报告使用）
 *
 * 需要 CRON_SECRET 鉴权。
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { logger } from '@/lib/logger'

export const maxDuration = 15

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = getSupabaseAdmin()
    const today = new Date().toISOString().split('T')[0]
    const todayStart = `${today}T00:00:00Z`

    // 并行查询所有统计
    const [
      signupsResult,
      totalUsersResult,
      activeUsersResult,
      newGroupsResult,
      newPostsResult,
      newCommentsResult,
      newFollowsResult,
      newClaimsResult,
      totalClaimsResult,
      pendingClaimsResult,
    ] = await Promise.all([
      // 今日新注册
      supabase
        .from('user_profiles')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      // 总注册用户
      supabase
        .from('user_profiles')
        .select('id', { count: 'exact', head: true }),

      // 今日活跃用户 (last_seen_at 更新于今天)
      supabase
        .from('user_profiles')
        .select('id', { count: 'exact', head: true })
        .gte('last_seen_at', todayStart),

      // 今日新建小组
      supabase
        .from('groups')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      // 今日新帖子
      supabase
        .from('posts')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      // 今日新评论
      supabase
        .from('comments')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      // 今日新关注（用户间）
      supabase
        .from('user_follows')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      // 今日新认领
      supabase
        .from('trader_claims')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', todayStart),

      // 总已认领（verified 状态）
      supabase
        .from('verified_traders')
        .select('id', { count: 'exact', head: true }),

      // 待审核认领
      supabase
        .from('trader_claims')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
    ])

    const activity = {
      date: today,
      signups: signupsResult.count ?? 0,
      total_users: totalUsersResult.count ?? 0,
      active_users: activeUsersResult.count ?? 0,
      new_groups: newGroupsResult.count ?? 0,
      new_posts: newPostsResult.count ?? 0,
      new_comments: newCommentsResult.count ?? 0,
      new_follows: newFollowsResult.count ?? 0,
      new_claims: newClaimsResult.count ?? 0,
      total_verified: totalClaimsResult.count ?? 0,
      pending_claims: pendingClaimsResult.count ?? 0,
    }

    return NextResponse.json({ ok: true, activity })
  } catch (err) {
    logger.error('[Analytics Activity] Error:', err)
    return NextResponse.json({ error: 'Internal error' }, { status: 500 })
  }
}
