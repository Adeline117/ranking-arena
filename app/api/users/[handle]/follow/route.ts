/**
 * Unified User Follow List API
 *
 * GET /api/users/[handle]/follow?list=followers  - Get user's followers list
 * GET /api/users/[handle]/follow?list=following   - Get user's following list
 *
 * Merges:
 *   - /api/users/[handle]/followers (deleted)
 *   - /api/users/[handle]/following (deleted)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, getAuthUser } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

export const dynamic = 'force-dynamic'

type FollowerRow = {
  follower?: { id?: string; handle?: string; bio?: string; avatar_url?: string }
  created_at?: string
}

type FollowingRow = {
  following?: { id?: string; handle?: string; bio?: string; avatar_url?: string }
  created_at?: string
}

async function fetchFollowStatus(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  requesterId: string,
  userIds: string[]
): Promise<Record<string, boolean>> {
  const { data: myFollows } = await supabase
    .from('user_follows')
    .select('following_id')
    .eq('follower_id', requesterId)
    .in('following_id', userIds)

  const status: Record<string, boolean> = {}
  if (myFollows) {
    for (const f of myFollows as { following_id: string }[]) {
      status[f.following_id] = true
    }
  }
  return status
}

async function getFollowersList(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  targetUser: { id: string; show_followers?: boolean },
  requesterId: string | null
) {
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
    return NextResponse.json({ error: 'Failed to fetch followers' }, { status: 500 })
  }

  let followStatus: Record<string, boolean> = {}
  if (requesterId && followers && followers.length > 0) {
    const followerIds = (followers as FollowerRow[])
      .map((f) => f.follower?.id)
      .filter(Boolean) as string[]
    followStatus = await fetchFollowStatus(supabase, requesterId, followerIds)
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
  supabase: ReturnType<typeof getSupabaseAdmin>,
  targetUser: { id: string; show_following?: boolean },
  requesterId: string | null
) {
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
    return NextResponse.json({ error: 'Failed to fetch following list' }, { status: 500 })
  }

  let followStatus: Record<string, boolean> = {}
  if (requesterId && following && following.length > 0) {
    const followingIds = (following as FollowingRow[])
      .map((f) => f.following?.id)
      .filter(Boolean) as string[]
    followStatus = await fetchFollowStatus(supabase, requesterId, followingIds)
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

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const resolvedParams = await Promise.resolve(params)
    const handle = resolvedParams.handle

    if (!handle) {
      return NextResponse.json({ error: 'Missing handle' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()
    const searchParams = request.nextUrl.searchParams
    const list = searchParams.get('list') // 'followers' | 'following'
    // Derive requesterId from auth token, not query params (prevents IDOR)
    const authUser = await getAuthUser(request)
    const requesterId = authUser?.id ?? null

    // Fetch cached follower/following counts directly from user_profiles.
    // These columns are kept in sync by updateFollowCounts() in
    // app/api/users/follow/route.ts after every follow/unfollow write,
    // so we don't need to re-count user_follows on every read.
    const { data: targetUser, error: userError } = await supabase
      .from('user_profiles')
      .select('id, handle, show_followers, show_following, follower_count, following_count')
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

    // Default: return both counts — served from the cached columns
    return NextResponse.json({
      followers_count: targetUser.follower_count ?? 0,
      following_count: targetUser.following_count ?? 0,
    })
  } catch (error: unknown) {
    logger.apiError('/api/users/[handle]/follow', error, { handle: (await params).handle })
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
