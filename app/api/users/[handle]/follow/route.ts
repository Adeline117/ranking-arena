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
import { withPublic } from '@/lib/api/middleware'
import { badRequest, notFound, serverError } from '@/lib/api/response'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { createLogger } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'
import {
  isPublicProfileActive,
  readPublicProfileAudienceByHandle,
} from '@/lib/profile/public-audience'

const logger = createLogger('users-follow')

export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

function noStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

type ProfileRow = {
  id: string
  handle: string | null
  bio: string | null
  avatar_url: string | null
  deleted_at: string | null
  banned_at: string | null
  is_banned: boolean | null
  ban_expires_at: string | null
}

// NOTE: user_follows.follower_id / following_id reference auth.users (not
// public.user_profiles), so PostgREST embeds of user_profiles fail with
// PGRST200. Two-step query: fetch follow rows, then look up profiles by id.
async function fetchProfilesByIds(
  supabase: SupabaseClient<Database>,
  ids: string[]
): Promise<Map<string, ProfileRow>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase
    .from('user_profiles')
    .select('id, handle, bio, avatar_url, deleted_at, banned_at, is_banned, ban_expires_at')
    .in('id', ids)
  if (error) throw error

  const now = Date.now()
  return new Map(
    (data || [])
      .filter((profile) => isPublicProfileActive(profile, now))
      .map((profile) => [profile.id, profile])
  )
}

async function fetchFollowStatus(
  supabase: SupabaseClient<Database>,
  requesterId: string,
  userIds: string[]
): Promise<Record<string, boolean>> {
  const { data: myFollows, error } = await supabase
    .from('user_follows')
    .select('following_id')
    .eq('follower_id', requesterId)
    .in('following_id', userIds)
  if (error) throw error

  const status: Record<string, boolean> = {}
  if (myFollows) {
    for (const f of myFollows as { following_id: string }[]) {
      status[f.following_id] = true
    }
  }
  return status
}

async function getFollowersList(
  supabase: SupabaseClient<Database>,
  targetUser: { id: string; show_followers?: boolean | null },
  requesterId: string | null
) {
  if (!targetUser.show_followers && requesterId !== targetUser.id) {
    return NextResponse.json(
      {
        followers: [],
        hidden: true,
        message: 'This user has hidden their followers list',
      },
      { headers: NO_STORE_HEADERS }
    )
  }

  const { data: followers, error: followersError } = await supabase
    .from('user_follows')
    .select('id, created_at, follower_id')
    .eq('following_id', targetUser.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (followersError) {
    logger.error('Fetch followers failed', { error: followersError, targetUserId: targetUser.id })
    return noStore(serverError('Failed to fetch followers'))
  }

  const followerRows = (followers || []) as {
    id: string
    created_at?: string
    follower_id: string
  }[]
  const followerIds = followerRows.map((f) => f.follower_id).filter(Boolean)
  const profileById = await fetchProfilesByIds(supabase, followerIds)

  let followStatus: Record<string, boolean> = {}
  if (requesterId && followerIds.length > 0) {
    followStatus = await fetchFollowStatus(supabase, requesterId, followerIds)
  }

  const formattedFollowers = followerRows
    .map((f) => {
      const profile = profileById.get(f.follower_id)
      return {
        id: profile?.id,
        handle: profile?.handle,
        bio: profile?.bio,
        avatar_url: profile?.avatar_url,
        followed_at: f.created_at,
        is_following: followStatus[profile?.id || ''] || false,
      }
    })
    .filter((f) => f.id)

  return NextResponse.json(
    {
      followers: formattedFollowers,
      count: formattedFollowers.length,
    },
    { headers: NO_STORE_HEADERS }
  )
}

async function getFollowingList(
  supabase: SupabaseClient<Database>,
  targetUser: { id: string; show_following?: boolean | null },
  requesterId: string | null
) {
  if (!targetUser.show_following && requesterId !== targetUser.id) {
    return NextResponse.json(
      {
        following: [],
        hidden: true,
        message: 'This user has hidden their following list',
      },
      { headers: NO_STORE_HEADERS }
    )
  }

  const { data: following, error: followingError } = await supabase
    .from('user_follows')
    .select('id, created_at, following_id')
    .eq('follower_id', targetUser.id)
    .order('created_at', { ascending: false })
    .limit(100)

  if (followingError) {
    logger.error('Fetch following failed', { error: followingError, targetUserId: targetUser.id })
    return noStore(serverError('Failed to fetch following list'))
  }

  const followingRows = (following || []) as {
    id: string
    created_at?: string
    following_id: string
  }[]
  const followingIds = followingRows.map((f) => f.following_id).filter(Boolean)
  const profileById = await fetchProfilesByIds(supabase, followingIds)

  let followStatus: Record<string, boolean> = {}
  if (requesterId && followingIds.length > 0) {
    followStatus = await fetchFollowStatus(supabase, requesterId, followingIds)
  }

  const formattedFollowing = followingRows
    .map((f) => {
      const profile = profileById.get(f.following_id)
      return {
        id: profile?.id,
        handle: profile?.handle,
        bio: profile?.bio,
        avatar_url: profile?.avatar_url,
        followed_at: f.created_at,
        is_following: followStatus[profile?.id || ''] || false,
      }
    })
    .filter((f) => f.id)

  return NextResponse.json(
    {
      following: formattedFollowing,
      count: formattedFollowing.length,
    },
    { headers: NO_STORE_HEADERS }
  )
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ handle: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const resolvedParams = await Promise.resolve(params)
  const handle = resolvedParams.handle

  if (!handle) {
    return noStore(badRequest('Missing handle'))
  }

  // Delegate to withPublic-wrapped handler with captured handle
  const handler = withPublic(
    async ({ user, supabase: sb }) => {
      const supabase: SupabaseClient<Database> = sb
      const searchParams = request.nextUrl.searchParams
      const list = searchParams.get('list') // 'followers' | 'following'
      // Derive requesterId from auth token (middleware provides user if auth header present)
      const requesterId = user?.id ?? null

      let decodedHandle: string
      try {
        decodedHandle = decodeURIComponent(handle)
      } catch {
        return noStore(badRequest('Invalid handle'))
      }

      const audience = await readPublicProfileAudienceByHandle(supabase, decodedHandle)
      if (audience.status !== 'active') {
        return noStore(notFound('User not found'))
      }

      // Re-read the exact authorized profile row with its privacy preferences.
      // Including current account state closes the race between resolving the
      // handle and materializing profile-owned follow data.
      const { data: targetUser, error: userError } = await supabase
        .from('user_profiles')
        .select(
          'id, handle, show_followers, show_following, follower_count, following_count, deleted_at, banned_at, is_banned, ban_expires_at'
        )
        .eq('id', audience.profile.id)
        .maybeSingle()

      if (userError) throw userError
      if (!targetUser || !isPublicProfileActive(targetUser)) {
        return noStore(notFound('User not found'))
      }

      if (list === 'followers') {
        return getFollowersList(supabase, targetUser, requesterId)
      }
      if (list === 'following') {
        return getFollowingList(supabase, targetUser, requesterId)
      }

      // Default: return both counts -- served from the cached columns
      return NextResponse.json(
        {
          followers_count: targetUser.follower_count ?? 0,
          following_count: targetUser.following_count ?? 0,
        },
        { headers: NO_STORE_HEADERS }
      )
    },
    { name: 'users-follow', rateLimit: 'public', readsAuth: true }
  )

  return handler(request)
}
