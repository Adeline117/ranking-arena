import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import UserProfileClient from './UserProfileClient'

export const revalidate = 60

interface UserProfileData {
  id: string
  handle: string
  bio?: string
  avatar_url?: string
  show_followers?: boolean
  show_following?: boolean
  followers: number
  following: number
  followingTraders: number
  isRegistered: boolean
  proBadgeTier: 'pro' | null
}

async function fetchUserProfile(handle: string): Promise<UserProfileData | null> {
  const supabase = getSupabaseAdmin()
  const decodedHandle = decodeURIComponent(handle)

  // Parallel lookup: by handle + by UUID (if applicable)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // Only select columns that actually exist in user_profiles table
  const selectFields = 'id, handle, bio, avatar_url, show_followers, show_following, subscription_tier'

  const [handleResult, uuidResult] = await Promise.all([
    supabase.from('user_profiles').select(selectFields).eq('handle', decodedHandle).maybeSingle(),
    uuidRegex.test(handle)
      ? supabase.from('user_profiles').select(selectFields).eq('id', handle).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const userProfile = handleResult.data || uuidResult.data

  if (!userProfile) return null

  // Parallel: fetch counts + pro badge
  let followers = 0
  let following = 0
  let tradersCount = 0
  let hasPro = userProfile.subscription_tier === 'pro'

  try {
    const [followersRes, followingRes, tradersRes, subscriptionData] = await Promise.all([
      supabase.from('user_follows').select('*', { count: 'exact', head: true }).eq('following_id', userProfile.id),
      supabase.from('user_follows').select('*', { count: 'exact', head: true }).eq('follower_id', userProfile.id),
      supabase.from('trader_follows').select('*', { count: 'exact', head: true }).eq('user_id', userProfile.id),
      supabase.from('subscriptions').select('tier, status').eq('user_id', userProfile.id).in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
    ])
    followers = followersRes.count || 0
    following = followingRes.count || 0
    tradersCount = tradersRes.count || 0
    hasPro = hasPro || subscriptionData?.data?.tier === 'pro'
  } catch (err) {
    console.error('[UserProfile] Failed to fetch counts:', err)
  }

  return {
    id: userProfile.id,
    handle: userProfile.handle || decodedHandle,
    bio: userProfile.bio || undefined,
    avatar_url: userProfile.avatar_url || undefined,
    show_followers: userProfile.show_followers,
    show_following: userProfile.show_following,
    followers,
    following,
    followingTraders: tradersCount,
    isRegistered: true,
    proBadgeTier: hasPro ? 'pro' : null,
  }
}

export default async function UserHomePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  const profile = await fetchUserProfile(handle)

  return (
    <Suspense>
      <UserProfileClient
        handle={handle}
        serverProfile={profile}
      />
    </Suspense>
  )
}
