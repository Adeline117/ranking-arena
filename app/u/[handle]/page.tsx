import { Suspense } from 'react'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import UserProfileClient from './UserProfileClient'

export const revalidate = 60

interface UserProfileData {
  id: string
  handle: string
  uid?: number
  bio?: string
  avatar_url?: string
  cover_url?: string
  show_followers?: boolean
  show_following?: boolean
  followers: number
  following: number
  followingTraders: number
  isRegistered: boolean
  socialLinks: {
    twitter?: string
    telegram?: string
    discord?: string
    github?: string
    website?: string
  }
  proBadgeTier: 'pro' | null
  walletAddress?: string
}

async function fetchUserProfile(handle: string): Promise<UserProfileData | null> {
  const supabase = getSupabaseAdmin()
  const decodedHandle = decodeURIComponent(handle)

  // Try by handle first
  const { data: profileByHandle } = await supabase
    .from('user_profiles')
    .select('*, show_followers, show_following, uid, cover_url, social_twitter, social_telegram, social_discord, social_github, social_website, show_pro_badge, subscription_tier')
    .eq('handle', decodedHandle)
    .maybeSingle()

  let userProfile = profileByHandle

  // Fallback: try by UUID
  if (!userProfile) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    if (uuidRegex.test(handle)) {
      const { data: profileById } = await supabase
        .from('user_profiles')
        .select('*, show_followers, show_following, uid, cover_url, social_twitter, social_telegram, social_discord, social_github, social_website, show_pro_badge, subscription_tier')
        .eq('id', handle)
        .maybeSingle()
      userProfile = profileById
    }
  }

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
      userProfile.show_pro_badge !== false
        ? supabase.from('subscriptions').select('tier, status').eq('user_id', userProfile.id).in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1).maybeSingle()
        : Promise.resolve({ data: null }),
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
    uid: userProfile.uid || undefined,
    bio: userProfile.bio || undefined,
    avatar_url: userProfile.avatar_url || undefined,
    cover_url: userProfile.cover_url || undefined,
    show_followers: userProfile.show_followers,
    show_following: userProfile.show_following,
    followers,
    following,
    followingTraders: tradersCount,
    isRegistered: true,
    socialLinks: {
      twitter: userProfile.social_twitter || undefined,
      telegram: userProfile.social_telegram || undefined,
      discord: userProfile.social_discord || undefined,
      github: userProfile.social_github || undefined,
      website: userProfile.social_website || undefined,
    },
    proBadgeTier: hasPro ? 'pro' : null,
    walletAddress: userProfile.wallet_address || undefined,
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
