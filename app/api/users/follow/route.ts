/**
 * 用户互相关注 API
 * GET: 检查关注状态
 * POST: 关注/取消关注用户
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

export const dynamic = 'force-dynamic'

/**
 * Recount and update follower_count / following_count on user_profiles.
 * Best-effort — failures are silently ignored.
 */
async function updateFollowCounts(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  followerId: string,
  followingId: string
): Promise<void> {
  // KEEP 'exact' — this is the write-path that rebuilds the cached
  // user_profiles.follower_count/following_count columns after a
  // follow/unfollow. The count MUST be exact here since downstream
  // reads trust those cached columns.
  const [followerCountRes, followingCountRes] = await Promise.all([
    supabase.from('user_follows').select('id', { count: 'exact', head: true }).eq('following_id', followingId),
    supabase.from('user_follows').select('id', { count: 'exact', head: true }).eq('follower_id', followerId),
  ])

  await Promise.all([
    supabase.from('user_profiles').update({ follower_count: followerCountRes.count ?? 0 }).eq('id', followingId),
    supabase.from('user_profiles').update({ following_count: followingCountRes.count ?? 0 }).eq('id', followerId),
  ])
}

/**
 * 验证用户身份并返回用户ID
 */

async function authenticateUser(request: NextRequest, _supabase: ReturnType<typeof getSupabaseAdmin>): Promise<{ userId: string } | { error: string; status: number }> {
  const { extractUserFromRequest } = await import('@/lib/auth/extract-user')
  const { user, error: authError } = await extractUserFromRequest(request)

  if (authError || !user) {
    return { error: 'Authentication failed', status: 401 }
  }

  return { userId: user.id }
}

// 获取关注状态
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()

    // 验证用户身份
    const authResult = await authenticateUser(request, supabase)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    const followerId = authResult.userId

    const searchParams = request.nextUrl.searchParams
    const followingId = searchParams.get('followingId')

    if (!followingId) {
      return NextResponse.json({ error: 'Missing followingId' }, { status: 400 })
    }

    // 并行检查双向关注状态
    const [{ data: followData, error: followError }, { data: reverseData }] = await Promise.all([
      supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followerId)
        .eq('following_id', followingId)
        .maybeSingle(),
      supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followingId)
        .eq('following_id', followerId)
        .maybeSingle(),
    ])

    if (followError && !followError.message?.includes('Could not find')) {
      logger.error('[User Follow API] 查询错误:', followError)
      return NextResponse.json({ error: 'Failed to check follow status' }, { status: 500 })
    }

    return NextResponse.json({
      following: !!followData,
      followedBy: !!reverseData,
      mutual: !!followData && !!reverseData
    })
  } catch (error: unknown) {
    logger.error('[User Follow API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// 关注/取消关注
export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const supabase = getSupabaseAdmin()

    // 验证用户身份 - followerId 必须从认证token获取
    const authResult = await authenticateUser(request, supabase)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }
    const followerId = authResult.userId

    const body = await request.json()
    const { followingId, action } = body

    if (!followingId || !action) {
      return NextResponse.json({ error: 'Missing followingId or action' }, { status: 400 })
    }

    if (followerId === followingId) {
      return NextResponse.json({ error: 'Cannot follow yourself' }, { status: 400 })
    }

    if (action === 'follow') {
      // 关注用户
      const { error } = await supabase
        .from('user_follows')
        .insert({ follower_id: followerId, following_id: followingId })

      if (error) {
        // 如果是重复关注，忽略错误
        if (error.code === '23505') {
          return NextResponse.json({ success: true, following: true })
        }
        if (error.message?.includes('Could not find the table')) {
          return NextResponse.json({ error: 'Follow feature not available yet', tableNotFound: true }, { status: 503 })
        }
        logger.error('[User Follow API] 关注错误:', error)
        return NextResponse.json({ error: 'Follow operation failed' }, { status: 500 })
      }

      // 检查是否互相关注
      const { data: reverseData } = await supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followingId)
        .eq('following_id', followerId)
        .maybeSingle()

      // Update follower/following counts (best-effort, recount from source of truth)
      fireAndForget(updateFollowCounts(supabase, followerId, followingId), 'Update follow counts')

      // Send follow notification (fire-and-forget)
      fireAndForget(
        (async () => {
          const { data: followerProfile } = await supabase
            .from('user_profiles')
            .select('handle')
            .eq('id', followerId)
            .maybeSingle()

          const followerHandle = followerProfile?.handle || 'Someone'
          await supabase
            .from('notifications')
            .insert({
              user_id: followingId,
              type: 'new_follower',
              title: 'New Follower',
              message: `${followerHandle} started following you`,
              actor_id: followerId,
              link: `/u/${followerHandle}`,
            })
        })(),
        'Send follow notification'
      )

      return NextResponse.json({ 
        success: true, 
        following: true,
        mutual: !!reverseData
      })
    } else if (action === 'unfollow') {
      // 取消关注
      const { error } = await supabase
        .from('user_follows')
        .delete()
        .eq('follower_id', followerId)
        .eq('following_id', followingId)

      if (error) {
        if (error.message?.includes('Could not find the table')) {
          return NextResponse.json({ error: 'Follow feature not available yet', tableNotFound: true }, { status: 503 })
        }
        logger.error('[User Follow API] 取消关注错误:', error)
        return NextResponse.json({ error: 'Unfollow operation failed' }, { status: 500 })
      }

      // Update follower/following counts (best-effort)
      fireAndForget(updateFollowCounts(supabase, followerId, followingId), 'Update follow counts')

      return NextResponse.json({ success: true, following: false, mutual: false })
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error: unknown) {
    logger.error('[User Follow API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}


