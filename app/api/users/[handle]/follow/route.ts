/**
 * Unified User Follow API
 *
 * GET  /api/users/[handle]/follow?list=followers  - Get user's followers list
 * GET  /api/users/[handle]/follow?list=following   - Get user's following list
 * GET  /api/users/[handle]/follow?followingId=xxx  - Check follow status (requires auth)
 * POST /api/users/[handle]/follow                  - Follow/unfollow user (requires auth)
 *
 * Merges:
 *   - /api/users/[handle]/followers
 *   - /api/users/[handle]/following
 *   - /api/users/follow
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

export const dynamic = 'force-dynamic'

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ''

/**
 * Recount and update follower_count / following_count on user_profiles.
 * Best-effort -- failures are silently ignored.
 */
async function updateFollowCounts(
  supabase: ReturnType<typeof createClient<any>>,
  followerId: string,
  followingId: string
): Promise<void> {
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
 * Authenticate user from Bearer token
 */
async function authenticateUser(
  request: NextRequest,
  supabase: ReturnType<typeof createClient<any>>
): Promise<{ userId: string } | { error: string; status: number }> {
  const authHeader = request.headers.get('Authorization')
  if (!authHeader?.startsWith('Bearer ')) {
    return { error: 'Unauthorized: missing auth token', status: 401 }
  }

  const token = authHeader.slice(7)
  const { data: { user }, error: authError } = await supabase.auth.getUser(token)

  if (authError || !user) {
    return { error: 'Authentication failed', status: 401 }
  }

  return { userId: user.id }
}

// ---------- Followers / Following list handlers ----------

type FollowerRow = {
  follower?: { id?: string; handle?: string; bio?: string; avatar_url?: string }
  created_at?: string
}

type FollowingRow = {
  following?: { id?: string; handle?: string; bio?: string; avatar_url?: string }
  created_at?: string
}

async function getFollowersList(
  supabase: ReturnType<typeof createClient<any>>,
  targetUser: { id: string; show_followers?: boolean },
  requesterId: string | null
) {
  // Privacy check
  if (!targetUser.show_followers && requesterId !== targetUser.id) {
    return NextResponse.json({
      followers: [],
      hidden: true,
      message: 'This user has hidden their followers list',
    })
  }

  const { data: followers, error: followersError } = await supabase
    .from('user_follows')
    .select(`
      id,
      created_at,
      follower:user_profiles!user_follows_follower_id_fkey(
        id,
        handle,
        bio,
        avatar_url
      )
    `)
    .eq('following_id', targetUser.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (followersError) {
    if (followersError.message?.includes('Could not find')) {
      return NextResponse.json({ followers: [], count: 0 })
    }
    logger.dbError('Fetch followers', followersError, { targetUserId: targetUser.id })
    return NextResponse.json({ error: followersError.message }, { status: 500 })
  }

  // Check if requester follows these followers
  let followStatus: Record<string, boolean> = {}
  if (requesterId && followers && followers.length > 0) {
    const followerIds = (followers as FollowerRow[])
      .map((f) => f.follower?.id)
      .filter(Boolean) as string[]

    const { data: myFollows } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', requesterId)
      .in('following_id', followerIds)

    if (myFollows) {
      followStatus = myFollows.reduce(
        (acc: Record<string, boolean>, f: { following_id: string }) => {
          acc[f.following_id] = true
          return acc
        },
        {}
      )
    }
  }

  const formattedFollowers = ((followers || []) as FollowerRow[])
    .map((f) => ({
      id: f.follower?.id,
      handle: f.follower?.handle,
      bio: f.follower?.bio,
      avatar_url: f.follower?.avatar_url,
      followed_at: f.created_at,
      is_following: followStatus[f.follower?.id || ''] || false,
    }))
    .filter((f) => f.id)

  return NextResponse.json({
    followers: formattedFollowers,
    count: formattedFollowers.length,
  })
}

async function getFollowingList(
  supabase: ReturnType<typeof createClient<any>>,
  targetUser: { id: string; show_following?: boolean },
  requesterId: string | null
) {
  // Privacy check
  if (!targetUser.show_following && requesterId !== targetUser.id) {
    return NextResponse.json({
      following: [],
      hidden: true,
      message: 'This user has hidden their following list',
    })
  }

  const { data: following, error: followingError } = await supabase
    .from('user_follows')
    .select(`
      id,
      created_at,
      following:user_profiles!user_follows_following_id_fkey(
        id,
        handle,
        bio,
        avatar_url
      )
    `)
    .eq('follower_id', targetUser.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (followingError) {
    if (followingError.message?.includes('Could not find')) {
      return NextResponse.json({ following: [], count: 0 })
    }
    logger.dbError('Fetch following', followingError, { targetUserId: targetUser.id })
    return NextResponse.json({ error: followingError.message }, { status: 500 })
  }

  // Check if requester follows these users
  let followStatus: Record<string, boolean> = {}
  if (requesterId && following && following.length > 0) {
    const followingIds = (following as FollowingRow[])
      .map((f) => f.following?.id)
      .filter(Boolean) as string[]

    const { data: myFollows } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', requesterId)
      .in('following_id', followingIds)

    if (myFollows) {
      followStatus = myFollows.reduce(
        (acc: Record<string, boolean>, f: { following_id: string }) => {
          acc[f.following_id] = true
          return acc
        },
        {}
      )
    }
  }

  const formattedFollowing = ((following || []) as FollowingRow[])
    .map((f) => ({
      id: f.following?.id,
      handle: f.following?.handle,
      bio: f.following?.bio,
      avatar_url: f.following?.avatar_url,
      followed_at: f.created_at,
      is_following: followStatus[f.following?.id || ''] || false,
    }))
    .filter((f) => f.id)

  return NextResponse.json({
    following: formattedFollowing,
    count: formattedFollowing.length,
  })
}

// ---------- GET handler ----------

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.authenticated)
    if (rateLimitResponse) return rateLimitResponse

    const resolvedParams = await Promise.resolve(params)
    const handle = resolvedParams.handle

    if (!handle) {
      return NextResponse.json({ error: 'Missing handle' }, { status: 400 })
    }

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)
    const searchParams = request.nextUrl.searchParams
    const list = searchParams.get('list') // 'followers' | 'following'
    const followingId = searchParams.get('followingId') // for checking follow status

    // --- Follow status check mode (was /api/users/follow?followingId=xxx) ---
    if (followingId) {
      const authResult = await authenticateUser(request, supabase)
      if ('error' in authResult) {
        return NextResponse.json({ error: authResult.error }, { status: authResult.status })
      }
      const followerId = authResult.userId

      const { data: followData, error: followError } = await supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followerId)
        .eq('following_id', followingId)
        .maybeSingle()

      if (followError && !followError.message?.includes('Could not find')) {
        logger.error('[User Follow API] Query error:', followError)
        return NextResponse.json({ error: followError.message }, { status: 500 })
      }

      const { data: reverseData } = await supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followingId)
        .eq('following_id', followerId)
        .maybeSingle()

      return NextResponse.json({
        following: !!followData,
        followedBy: !!reverseData,
        mutual: !!followData && !!reverseData,
      })
    }

    // --- List mode (was /api/users/[handle]/followers or /following) ---
    const requesterId = searchParams.get('requesterId')

    const { data: targetUser, error: userError } = await supabase
      .from('user_profiles')
      .select('id, handle, show_followers, show_following')
      .eq('handle', handle)
      .maybeSingle()

    if (userError || !targetUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    if (list === 'followers') {
      return getFollowersList(supabase, targetUser, requesterId)
    }
    if (list === 'following') {
      return getFollowingList(supabase, targetUser, requesterId)
    }

    // Default: return both counts
    const [followersCount, followingCount] = await Promise.all([
      supabase.from('user_follows').select('id', { count: 'exact', head: true }).eq('following_id', targetUser.id),
      supabase.from('user_follows').select('id', { count: 'exact', head: true }).eq('follower_id', targetUser.id),
    ])

    return NextResponse.json({
      followers_count: followersCount.count ?? 0,
      following_count: followingCount.count ?? 0,
    })
  } catch (error: unknown) {
    logger.apiError('/api/users/[handle]/follow', error, { handle: (await params).handle })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

// ---------- POST handler (follow/unfollow) ----------

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return NextResponse.json({ error: 'Missing Supabase config' }, { status: 500 })
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

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
      const { error } = await supabase
        .from('user_follows')
        .insert({ follower_id: followerId, following_id: followingId })

      if (error) {
        if (error.code === '23505') {
          return NextResponse.json({ success: true, following: true })
        }
        if (error.message?.includes('Could not find the table')) {
          return NextResponse.json(
            { error: 'Follow feature not available yet', tableNotFound: true },
            { status: 503 }
          )
        }
        logger.error('[User Follow API] Follow error:', error)
        return NextResponse.json({ error: 'Follow operation failed' }, { status: 500 })
      }

      // Check mutual follow
      const { data: reverseData } = await supabase
        .from('user_follows')
        .select('id')
        .eq('follower_id', followingId)
        .eq('following_id', followerId)
        .maybeSingle()

      // Update counts (best-effort)
      fireAndForget(updateFollowCounts(supabase, followerId, followingId), 'Update follow counts')

      // Send follow notification (best-effort)
      const { data: followerProfile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', followerId)
        .maybeSingle()

      const followerHandle = followerProfile?.handle || 'Someone'
      await supabase.from('notifications').insert({
        user_id: followingId,
        type: 'new_follower',
        title: 'New Follower',
        message: `${followerHandle} started following you`,
        actor_id: followerId,
        link: `/u/${followerHandle}`,
      })

      return NextResponse.json({
        success: true,
        following: true,
        mutual: !!reverseData,
      })
    } else if (action === 'unfollow') {
      const { error } = await supabase
        .from('user_follows')
        .delete()
        .eq('follower_id', followerId)
        .eq('following_id', followingId)

      if (error) {
        if (error.message?.includes('Could not find the table')) {
          return NextResponse.json(
            { error: 'Follow feature not available yet', tableNotFound: true },
            { status: 503 }
          )
        }
        logger.error('[User Follow API] Unfollow error:', error)
        return NextResponse.json({ error: 'Unfollow operation failed' }, { status: 500 })
      }

      fireAndForget(updateFollowCounts(supabase, followerId, followingId), 'Update follow counts')

      return NextResponse.json({ success: true, following: false, mutual: false })
    } else {
      return NextResponse.json({ error: 'Invalid action' }, { status: 400 })
    }
  } catch (error: unknown) {
    logger.error('[User Follow API] Error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
