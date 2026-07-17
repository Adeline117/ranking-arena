import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getReadReplica } from '@/lib/supabase/read-replica'
import UserProfileClient from './UserProfileClient'
import { logger } from '@/lib/logger'
import { BASE_URL } from '@/lib/constants/urls'
// M1 unified profile: claimed/bound traders render the SAME rich serving client
// as /trader/[handle] (was a legacy-only TraderProfileView — "claim 后页面变穷").
import TraderProfileClient, {
  type UnregisteredTraderData,
} from '@/app/(app)/trader/[handle]/TraderProfileClient'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getFirstScreen } from '@/lib/data/serving/first-screen'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { getDataMode } from '@/lib/constants/serving-cutover'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import { ErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { isPublicProfileActive } from '@/lib/profile/public-audience'

// Account moderation/deletion state is a request-time public audience boundary.
// Do not let an ISR payload keep serving a profile after that state changes.
export const dynamic = 'force-dynamic'
export const revalidate = 0

// SSR timeout: during cron contention, Supabase queries can block on row locks
// for 30+ seconds. Race against this timeout so users see a fast fallback.
const SSR_TIMEOUT_MS = 4000

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>
}): Promise<Metadata> {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)

  // Fetch profile + claimed trader data for richer social previews
  let avatarUrl: string | null = null
  let traderMeta: { roi?: number; score?: number; platform?: string } | null = null
  try {
    const supabase = getSupabaseAdmin()
    const { data } = await Promise.race([
      supabase
        .from('user_profiles')
        .select(
          'id, handle, avatar_url, bio, verified_trader_source, verified_trader_id, deleted_at, banned_at, is_banned, ban_expires_at'
        )
        .eq('handle', decoded)
        .maybeSingle(),
      new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), SSR_TIMEOUT_MS)
      ),
    ])
    const publicData = data && isPublicProfileActive(data) ? data : null
    avatarUrl = publicData?.avatar_url || null

    // If user claimed a trader, fetch their trading stats for meta description
    if (publicData?.verified_trader_source && publicData?.verified_trader_id) {
      const { data: lr } = await Promise.race([
        supabase
          .from('leaderboard_ranks')
          .select('roi, arena_score, source')
          .eq('source', publicData.verified_trader_source)
          .eq('source_trader_id', publicData.verified_trader_id)
          .eq('season_id', '90D')
          .maybeSingle(),
        new Promise<{ data: null }>((resolve) =>
          setTimeout(() => resolve({ data: null }), SSR_TIMEOUT_MS)
        ),
      ])
      if (lr) {
        traderMeta = {
          roi: lr.roi ?? undefined,
          score: lr.arena_score ?? undefined,
          platform: lr.source,
        }
      }
    }
  } catch {
    /* use default */
  }

  const title = `@${decoded} — Arena Profile`
  const traderParts = traderMeta
    ? [
        traderMeta.roi != null
          ? `${traderMeta.roi >= 0 ? '+' : ''}${traderMeta.roi.toFixed(1)}% ROI`
          : null,
        traderMeta.score != null ? `Score ${traderMeta.score.toFixed(0)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null
  const description = traderParts
    ? `@${decoded} — Verified trader${traderMeta?.platform ? ` on ${traderMeta.platform}` : ''} (${traderParts}). View performance, analytics, and rankings on Arena.`
    : `View @${decoded}'s trading stats, posts, and activity on Arena — the crypto trader ranking platform.`
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
      .select('id, handle, deleted_at, banned_at, is_banned, ban_expires_at')
      .not('handle', 'is', null)
      .order('created_at', { ascending: true })
      .limit(30)

    return (data || [])
      .filter(
        (u): u is typeof u & { handle: string } =>
          typeof u.handle === 'string' && isPublicProfileActive(u)
      )
      .map((u) => ({ handle: u.handle }))
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
  /** M1 unified profile: exact trader identity when known (claim OR exchange
   *  bind), so the serving resolver can match by exchange_trader_id. */
  traderPlatform?: string
  traderSourceId?: string
  created_at?: string
}

async function fetchUserProfile(handle: string): Promise<UserProfileData | null> {
  const supabase = getSupabaseAdmin()
  const decodedHandle = decodeURIComponent(handle)

  // Parallel lookup: by handle + by UUID (if applicable)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  // Only select columns that actually exist in user_profiles table
  // follower_count / following_count are cached columns — avoid re-counting.
  const selectFields =
    'id, handle, bio, avatar_url, cover_url, show_followers, show_following, subscription_tier, show_pro_badge, role, follower_count, following_count, created_at, deleted_at, banned_at, is_banned, ban_expires_at'

  const [handleResult, handleIlikeResult, uuidResult] = await Promise.race([
    Promise.all([
      supabase.from('user_profiles').select(selectFields).eq('handle', decodedHandle).maybeSingle(),
      // Case-insensitive fallback
      supabase
        .from('user_profiles')
        .select(selectFields)
        .ilike('handle', decodedHandle)
        .maybeSingle(),
      uuidRegex.test(handle)
        ? supabase.from('user_profiles').select(selectFields).eq('id', handle).maybeSingle()
        : Promise.resolve({ data: null }),
    ]),
    new Promise<[{ data: null }, { data: null }, { data: null }]>((resolve) =>
      setTimeout(() => resolve([{ data: null }, { data: null }, { data: null }]), SSR_TIMEOUT_MS)
    ),
  ])

  const userProfile = handleResult.data || handleIlikeResult.data || uuidResult.data

  if (!userProfile || !isPublicProfileActive(userProfile)) return null

  // Parallel: fetch counts + pro badge
  let followers = 0
  let following = 0
  let tradersCount = 0
  let hasPro = userProfile.subscription_tier === 'pro'
  let hasClaimedTrader = false
  let traderHandle: string | undefined
  let traderPlatform: string | undefined
  let traderSourceId: string | undefined

  // followers / following served from the cached columns above.
  // trader_follows is scoped to a single user so the count stays cheap,
  // but we switch to estimated to keep page SSR bounded under DB load —
  // the "following N traders" display is a rounded marketing number.
  followers = (userProfile as { follower_count?: number | null }).follower_count ?? 0
  following = (userProfile as { following_count?: number | null }).following_count ?? 0

  try {
    const [tradersRes, subscriptionData, claimedTraderRes] = await Promise.race([
      Promise.all([
        supabase
          .from('trader_follows')
          .select('id', { count: 'estimated', head: true })
          .eq('user_id', userProfile.id),
        supabase
          .from('subscriptions')
          .select('tier, status')
          .eq('user_id', userProfile.id)
          .in('status', ['active', 'trialing'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('trader_authorizations')
          .select('id, trader_id, platform')
          .eq('user_id', userProfile.id)
          .eq('status', 'active')
          .limit(1)
          .maybeSingle(),
      ]),
      new Promise<[{ count: null }, { data: null }, { data: null }]>((resolve) =>
        setTimeout(() => resolve([{ count: null }, { data: null }, { data: null }]), SSR_TIMEOUT_MS)
      ),
    ])
    tradersCount = tradersRes.count || 0
    hasPro = hasPro || subscriptionData?.data?.tier === 'pro'
    hasClaimedTrader = !!claimedTraderRes?.data

    // If user has a claimed trader, fetch the trader handle
    if (claimedTraderRes?.data?.trader_id && claimedTraderRes?.data?.platform) {
      traderPlatform = claimedTraderRes.data.platform
      traderSourceId = claimedTraderRes.data.trader_id
      try {
        const { data: traderRow } = await supabase
          .from('trader_sources')
          .select('handle')
          .eq('source', claimedTraderRes.data.platform)
          .eq('source_trader_id', claimedTraderRes.data.trader_id)
          .maybeSingle()
        if (traderRow?.handle) {
          traderHandle = traderRow.handle
        }
      } catch {
        // Intentionally swallowed: claimed trader handle lookup is optional enrichment
      }
    } else {
      // M1-1b (unified profile): an exchange-BOUND user (verified API-key bind,
      // no claim yet) also gets the trader-detail view — identity comes from the
      // verified UID on the connection. Claim remains what sets the verified badge.
      try {
        const { data: conn } = await supabase
          .from('user_exchange_connections')
          .select('exchange, verified_uid')
          .eq('user_id', userProfile.id)
          .eq('is_active', true)
          .not('verified_uid', 'is', null)
          .limit(1)
          .maybeSingle()
        if (conn?.verified_uid && conn.exchange) {
          traderPlatform = conn.exchange
          traderSourceId = conn.verified_uid
        }
      } catch {
        // Optional enrichment — bound-trader lookup failure never blocks the page.
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
    show_followers: userProfile.show_followers ?? undefined,
    show_following: userProfile.show_following ?? undefined,
    followers,
    following,
    followingTraders: tradersCount,
    isRegistered: true,
    isVerifiedTrader: hasClaimedTrader,
    proBadgeTier: hasPro && userProfile.show_pro_badge !== false ? 'pro' : null,
    role: userProfile.role || undefined,
    traderHandle,
    traderPlatform,
    traderSourceId,
    created_at: userProfile.created_at || undefined,
  }
}

async function fetchTraderData(traderHandle: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const res = await fetch(`${baseUrl}/api/traders/${encodeURIComponent(traderHandle)}`, {
      next: { revalidate: 60 },
    })
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

/**
 * M1 unified profile: resolve the claimed/bound trader against the arena.*
 * serving read path. Success → the /u page renders the SAME TraderProfileClient
 * as /trader/[handle] (rich serving modules, claimedUser overlay). Timeout or a
 * non-serving source → null, and the caller falls back to the legacy view.
 */
async function resolveServingForUser(profile: {
  traderHandle?: string
  traderPlatform?: string
  traderSourceId?: string
}): Promise<{
  source: string
  exchangeTraderId: string
  nickname: string | null
  avatarMirrorUrl: string | null
  avatarOriginUrl: string | null
} | null> {
  // arena_resolve_trader matches exchange_trader_id first (exact), so the bound
  // UID works even when no legacy trader_sources handle exists.
  const lookup = profile.traderHandle ?? profile.traderSourceId
  if (!lookup) return null
  try {
    // Only pass the platform as a hint when it is itself a serving source —
    // a stale legacy hint (e.g. "gateio") makes the RPC return nothing.
    const hint =
      profile.traderPlatform && (await getDataMode(profile.traderPlatform)) === 'serving'
        ? profile.traderPlatform
        : undefined
    const resolved = await Promise.race([
      resolveServingTrader(getReadReplica(), { handle: lookup, source: hint }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_TIMEOUT_MS)),
    ])
    if (!resolved) return null
    if ((await getDataMode(resolved.source)) !== 'serving') return null
    return resolved
  } catch (err) {
    logger.error('[u/page] serving resolve failed:', err instanceof Error ? err.message : err)
    return null
  }
}

export default async function UserHomePage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  const profile = await fetchUserProfile(handle)

  // ── M1 unified profile: serving-mode traders get the full /trader client ──
  if (profile && (profile.traderHandle || profile.traderSourceId)) {
    const servingResolved = await resolveServingForUser(profile)
    if (servingResolved) {
      const [firstScreenRaw, capabilities] = await Promise.all([
        Promise.race([
          getFirstScreen(
            getReadReplica(),
            servingResolved.source,
            servingResolved.exchangeTraderId
          ),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_TIMEOUT_MS)),
        ]).catch(() => null),
        getSourceCapabilities(getReadReplica()).catch(
          () => ({}) as Awaited<ReturnType<typeof getSourceCapabilities>>
        ),
      ])
      // Synthesize a minimal first-screen on timeout — same root-cause fix as
      // /trader/page.tsx: never fall back to the legacy 404 path for a serving
      // trader; the client fetches /core with its own skeletons.
      const firstScreen: TraderFirstScreen = firstScreenRaw ?? {
        source: servingResolved.source,
        exchangeTraderId: servingResolved.exchangeTraderId,
        nickname: servingResolved.nickname,
        avatarMirrorUrl: servingResolved.avatarMirrorUrl,
        avatarOriginUrl: servingResolved.avatarOriginUrl,
        avatarSrc: getTraderAvatarSrc({
          avatarMirrorUrl: servingResolved.avatarMirrorUrl,
          avatarOriginUrl: servingResolved.avatarOriginUrl,
        }),
        walletAddress: null,
        traderKind: 'human',
        botStrategy: null,
        entries: [],
      }
      const entries = firstScreen.entries ?? []
      const best =
        entries.find((e) => e.timeframe === 90) ??
        entries.find((e) => e.timeframe === 30) ??
        entries[0]
      const verifiedKeys = await getVerifiedTraderKeys(getReadReplica())
      const servingTraderData: UnregisteredTraderData = {
        handle: profile.handle,
        avatar_url: profile.avatar_url ?? firstScreen.avatarSrc ?? null,
        source: servingResolved.source,
        source_trader_id: servingResolved.exchangeTraderId,
        rank: best?.rank ?? null,
        roi: best?.headlineRoi ?? null,
        pnl: best?.headlinePnl?.value ?? null,
        win_rate:
          best?.headlineWinRate ??
          (typeof best?.extras.win_rate === 'number' ? (best.extras.win_rate as number) : null),
        max_drawdown: typeof best?.extras.mdd === 'number' ? (best.extras.mdd as number) : null,
        is_verified_data: verifiedKeys.has(
          verifiedTraderKey(servingResolved.source, servingResolved.exchangeTraderId)
        ),
      }
      return (
        <ErrorBoundary pageType="trader-profile">
          <TraderProfileClient
            data={servingTraderData}
            serverTraderData={null}
            claimedUser={{
              id: profile.id,
              handle: profile.handle,
              bio: profile.bio ?? null,
              avatar_url: profile.avatar_url ?? null,
              cover_url: profile.cover_url ?? null,
            }}
            dataMode="serving"
            servingFirstScreen={firstScreen}
            servingCapability={capabilities[servingResolved.source] ?? null}
          />
        </ErrorBoundary>
      )
    }
  }

  // If user is a trader, fetch their trading data (legacy fallback path)
  let traderData = null
  if (profile?.traderHandle) {
    traderData = await fetchTraderData(profile.traderHandle)
  }

  // JSON-LD structured data for search engines
  const personSchema = profile
    ? {
        '@context': 'https://schema.org',
        '@type': 'ProfilePage',
        mainEntity: {
          '@type': 'Person',
          name: profile.handle,
          ...(profile.avatar_url ? { image: profile.avatar_url } : {}),
          ...(profile.bio ? { description: profile.bio } : {}),
          url: `${BASE_URL}/u/${encodeURIComponent(profile.handle)}`,
        },
      }
    : null

  return (
    <>
      {personSchema && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(personSchema).replace(/</g, '\\u003c'),
          }}
        />
      )}
      <Suspense>
        <UserProfileClient handle={handle} serverProfile={profile} serverTraderData={traderData} />
      </Suspense>
    </>
  )
}
