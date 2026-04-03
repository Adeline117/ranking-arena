import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import UserProfileClient from './UserProfileClient'
import { logger } from '@/lib/logger'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 60

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)

  // Try to fetch avatar for OG image
  let avatarUrl: string | null = null
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('user_profiles')
      .select('avatar_url')
      .eq('handle', decoded)
      .maybeSingle()
    avatarUrl = data?.avatar_url || null
  } catch { /* use default */ }

  const title = `@${decoded} — Arena Profile`
  const description = `View @${decoded}'s trading stats, posts, and activity on Arena — the crypto trader ranking platform.`
  const ogImage = avatarUrl || `${BASE_URL}/api/og`
  const profileUrl = `${BASE_URL}/u/${encodeURIComponent(decoded)}`

  return {
    title,
    description,
    alternates: { canonical: profileUrl },
    openGraph: {
      title,
      description,
      url: profileUrl,
      siteName: 'Arena',
      type: 'profile',
      images: [{ url: ogImage, width: avatarUrl ? 400 : 1200, height: avatarUrl ? 400 : 630 }],
    },
    twitter: {
      card: avatarUrl ? 'summary' : 'summary_large_image',
      title,
      description,
      creator: '@arenafi',
      images: [ogImage],
    },
  }
}

// Pre-render top user profiles at build time for instant TTFB
export async function generateStaticParams() {
  // Skip during build — Supabase queries hang from Vercel build servers
  if (process.env.NEXT_PHASE === 'phase-production-build') return []

  try {
    const supabase = getSupabaseAdmin()
    const { data } = await supabase
      .from('user_profiles')
      .select('handle')
      .not('handle', 'is', null)
      .order('created_at', { ascending: true })
      .limit(30)
    
    return (data || [])
      .filter((u: { handle: string | null }) => u.handle)
      .map((u: { handle: string }) => ({ handle: u.handle }))
  } catch {
    return []
  }
}

interface UserProfileData {
  id: string
  handle: string
  bio?: string
  avatar_url?: string
  cover_url?: string
  show_followers?: boolean
  show_following?: boolean
  followers: number
  following: number
  followingTraders: number
  isRegistered: boolean
  isVerifiedTrader?: boolean
  proBadgeTier: 'pro' | null
  role?: string
  traderHandle?: string
}

async function fetchUserProfile(handle: string): Promise<UserProfileData | null> {
  const supabase = getSupabaseAdmin()
  const decodedHandle = decodeURIComponent(handle)

  // Parallel lookup: by handle + by UUID (if applicable)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // Only select columns that actually exist in user_profiles table
  const selectFields = 'id, handle, bio, avatar_url, cover_url, show_followers, show_following, subscription_tier, show_pro_badge, role'

  const [handleResult, handleIlikeResult, uuidResult] = await Promise.all([
    supabase.from('user_profiles').select(selectFields).eq('handle', decodedHandle).maybeSingle(),
    // Case-insensitive fallback
    supabase.from('user_profiles').select(selectFields).ilike('handle', decodedHandle).maybeSingle(),
    uuidRegex.test(handle)
      ? supabase.from('user_profiles').select(selectFields).eq('id', handle).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const userProfile = handleResult.data || handleIlikeResult.data || uuidResult.data

  if (!userProfile) return null

  // Parallel: fetch counts + pro badge
  let followers = 0
  let following = 0
  let tradersCount = 0
  let hasPro = userProfile.subscription_tier === 'pro'
  let hasClaimedTrader = false
  let traderHandle: string | undefined

  try {
    const [followersRes, followingRes, tradersRes, subscriptionData, claimedTraderRes] = await Promise.all([
      supabase.from('user_follows').select('id', { count: 'exact', head: true }).eq('following_id', userProfile.id),
      supabase.from('user_follows').select('id', { count: 'exact', head: true }).eq('follower_id', userProfile.id),
      supabase.from('trader_follows').select('id', { count: 'exact', head: true }).eq('user_id', userProfile.id),
      supabase.from('subscriptions').select('tier, status').eq('user_id', userProfile.id).in('status', ['active', 'trialing']).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('trader_authorizations').select('id, trader_id').eq('user_id', userProfile.id).eq('status', 'active').limit(1).maybeSingle(),
    ])
    followers = followersRes.count || 0
    following = followingRes.count || 0
    tradersCount = tradersRes.count || 0
    hasPro = hasPro || subscriptionData?.data?.tier === 'pro'
    hasClaimedTrader = !!claimedTraderRes?.data
    
    // If user has a claimed trader, fetch the trader handle
    if (claimedTraderRes?.data?.trader_id) {
      try {
        const { data: traderRow } = await supabase
          .from('traders')
          .select('handle')
          .eq('id', claimedTraderRes.data.trader_id)
          .maybeSingle()
        if (traderRow?.handle) {
          traderHandle = traderRow.handle
        }
      } catch {
        // Intentionally swallowed: claimed trader handle lookup is optional enrichment
      }
    }
  } catch (err) {
    logger.error('[UserProfile] Failed to fetch counts:', err)
  }

  return {
    id: userProfile.id,
    handle: userProfile.handle || decodedHandle,
    bio: userProfile.bio || undefined,
    avatar_url: userProfile.avatar_url || undefined,
    cover_url: userProfile.cover_url || undefined,
    show_followers: userProfile.show_followers,
    show_following: userProfile.show_following,
    followers,
    following,
    followingTraders: tradersCount,
    isRegistered: true,
    isVerifiedTrader: hasClaimedTrader,
    proBadgeTier: hasPro && userProfile.show_pro_badge !== false ? 'pro' : null,
    role: userProfile.role || undefined,
    traderHandle,
  }
}

async function fetchTraderData(traderHandle: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const res = await fetch(
      `${baseUrl}/api/traders/${encodeURIComponent(traderHandle)}`,
      { next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    const json = await res.json()
    // Unwrap API envelope { success, data } to get the raw trader data
    if (json && typeof json === 'object' && 'data' in json && 'success' in json) {
      return json.data
    }
    return json
  } catch {
    return null
  }
}

export default async function UserHomePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  const profile = await fetchUserProfile(handle)

  // If user is a trader, fetch their trading data
  let traderData = null
  if (profile?.traderHandle) {
    traderData = await fetchTraderData(profile.traderHandle)
  }

  return (
    <Suspense>
      <UserProfileClient
        handle={handle}
        serverProfile={profile}
        serverTraderData={traderData}
      />
    </Suspense>
  )
}
