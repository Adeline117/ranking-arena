import type { Metadata } from 'next'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { redirect, notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { ErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { isDead } from '@/lib/connectors/route-config'
import { LR } from '@/lib/types/schema-mapping'
import { BASE_URL } from '@/lib/constants/urls'
import { generateTraderProfilePageSchema, type TraderSchemaInput } from '@/lib/seo/structured-data'

// Derive display names from central config
const EXCHANGE_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.name])
)

// ---------------------------------------------------------------------------
// unstable_cache wrappers — use Next.js data cache instead of Redis.
// Upstash SDK uses cache: 'no-store' internally which breaks ISR entirely.
// These functions populate the Next.js data cache (revalidated every 5 min).
// ---------------------------------------------------------------------------

const cachedResolveTraderISR = unstable_cache(
  async (handle: string, platform: string | undefined) => {
    const result = await resolveTrader(getSupabaseAdmin(), { handle, platform })
    if (!result) {
      // Throw so unstable_cache does NOT cache null results.
      // A transient DB timeout should not cause 5 minutes of 404s.
      throw new Error('TRADER_RESOLVE_NULL')
    }
    return result
  },
  ['trader-resolve'],
  { revalidate: 300, tags: ['trader-profile'] }
)

// React cache() deduplicates the ISR-cached call within a single request.
// Both generateMetadata and the page component call this — one DB round-trip.
// Catches the TRADER_RESOLVE_NULL sentinel so callers get null (not an exception).
const cachedResolveTrader = cache(
  async (handle: string, platform?: string) => {
    try {
      return await cachedResolveTraderISR(handle, platform)
    } catch {
      return null
    }
  }
)

// Heavy query (~11 parallel DB queries). Caching this eliminates the dominant
// TTFB contribution on repeat requests (expected: 973ms -> <200ms on cache hit).
const cachedGetTraderDetail = unstable_cache(
  async (platform: string, traderKey: string) => {
    return getTraderDetail(getSupabaseAdmin(), { platform, traderKey })
  },
  ['trader-detail'],
  { revalidate: 300, tags: ['trader-profile'] }
)

// Cached leaderboard query for OG metadata.
// Avoids a duplicate DB query between generateMetadata and the page render.
const cachedLeaderboardMeta = unstable_cache(
  async (platform: string, traderKey: string) => {
    const { data } = await getSupabaseAdmin()
      .from('leaderboard_ranks')
      .select('rank, arena_score, roi, pnl')
      .eq(LR.source, platform)
      .eq(LR.source_trader_id, traderKey)
      .eq(LR.season_id, '90D')
      .maybeSingle()
    return data
  },
  ['trader-lb-meta'],
  { revalidate: 300, tags: ['trader-profile'] }
)

// Cached user handle lookup for claimed trader pages.
const cachedFindUserHandleByTrader = unstable_cache(
  async (traderHandle: string): Promise<string | null> => {
    try {
      const supabase = getSupabaseAdmin()
      const { data: trader } = await supabase
        .from('traders')
        .select('id, trader_authorizations!inner(user_id, user_profiles:user_id(handle))')
        .eq('handle', traderHandle)
        .eq('trader_authorizations.status', 'active')
        .maybeSingle()

      if (!trader) return null

      const auths = trader.trader_authorizations as unknown as Array<{ user_id: string; user_profiles: { handle: string | null } | null }>
      return auths?.[0]?.user_profiles?.handle || null
    } catch {
      // Fallback: query via trader_authorizations table
      try {
        const supabase = getSupabaseAdmin()
        const { data: auth } = await supabase
          .from('trader_authorizations')
          .select('user_id, traders!inner(handle), user_profiles:user_id(handle)')
          .eq('traders.handle', traderHandle)
          .eq('status', 'active')
          .maybeSingle()

        if (!auth) return null
        const profile = auth.user_profiles as unknown as { handle: string | null } | null
        return profile?.handle || null
      } catch {
        return null
      }
    }
  },
  ['trader-user-handle'],
  { revalidate: 300, tags: ['trader-profile'] }
)

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params
  // Reject absurdly long handles early to prevent cache key bloat and DB abuse
  if (handle.length > 300) return notFound()
  const decoded = decodeURIComponent(handle)
  const BASE = BASE_URL

  try {
    // Use cached resolver — deduplicates with the page component's resolveTrader call
    const resolved = await cachedResolveTrader(decoded)

    if (resolved) {
      // Use cached leaderboard fetch — avoids duplicate query with page render
      const lr = await cachedLeaderboardMeta(resolved.platform, resolved.traderKey)

      const name = resolved.handle || decoded
      const exchange = EXCHANGE_DISPLAY[resolved.platform] || resolved.platform || 'Crypto'
      const roi = lr?.roi
      const score = lr?.arena_score
      const rank = lr?.rank

      const parts = [
        roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null,
        score != null ? `Arena Score ${score.toFixed(0)}` : null,
        rank != null ? `Ranked ${rank}` : null,
      ].filter(Boolean)

      const title = `${name} (${exchange}) | Crypto Trader Rankings`
      const rawDescription = parts.length
        ? `${name} is a ${exchange} trader with ${parts.join(', ')}. Track performance history, analytics, and rankings on Arena.`
        : `${name} is a ${exchange} crypto trader. View performance analytics, trading history, risk metrics, and rankings on Arena.`
      const description = rawDescription.length > 160 ? rawDescription.substring(0, 157) + '...' : rawDescription

      const ogParams = new URLSearchParams({ handle: decoded })
      if (roi != null) ogParams.set('roi', roi.toFixed(2))
      if (score != null) ogParams.set('score', score.toFixed(0))
      if (rank != null) ogParams.set('rank', String(rank))
      if (resolved.platform) ogParams.set('source', resolved.platform)
      const ogImageUrl = `${BASE}/api/og/trader?${ogParams.toString()}`

      return {
        title,
        description,
        openGraph: {
          title,
          description,
          url: `${BASE}/trader/${encodeURIComponent(decoded)}`,
          siteName: 'Arena',
          type: 'profile',
          images: [{ url: ogImageUrl, width: 1200, height: 630, alt: `${name} trading performance card` }],
        },
        twitter: {
          card: 'summary_large_image',
          title,
          description: description.length > 160 ? description.substring(0, 157) + '...' : description,
          images: [ogImageUrl],
          creator: '@arenafi',
        },
        alternates: { canonical: `${BASE}/trader/${encodeURIComponent(decoded)}` },
      }
    }
  } catch { /* fall through */ }

  // Fallback — no DB data
  const fallbackOgImage = `${BASE}/api/og/trader?handle=${encodeURIComponent(decoded)}`
  return {
    title: `${decoded} | Crypto Trader Rankings`,
    description: `View ${decoded}'s crypto trading performance, PnL, ROI, win rate, and rank on Arena — 34,000+ traders across 28+ exchanges.`,
    openGraph: {
      title: `${decoded} | Crypto Trader`,
      description: `View ${decoded}'s crypto trading performance, analytics, and rank on Arena among 34,000+ traders across 28+ exchanges.`,
      url: `${BASE}/trader/${encodeURIComponent(decoded)}`,
      siteName: 'Arena',
      type: 'profile',
      images: [{ url: fallbackOgImage, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${decoded} | Crypto Trader`,
      description: `View ${decoded}'s trading performance and rank on Arena.`,
      images: [fallbackOgImage],
      creator: '@arenafi',
    },
    alternates: { canonical: `${BASE}/trader/${encodeURIComponent(decoded)}` },
  }
}

// Allow non-pre-rendered trader pages to be dynamically generated at runtime
export const dynamicParams = true

// ISR: regenerate trader pages every 5 minutes
// Sidebar widgets are client components using SWR (no server-side Redis dependency)
export const revalidate = 300

export default async function TraderPage({ params, searchParams }: { params: Promise<{ handle: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { handle } = await params
  const allSearchParams = await searchParams
  const platform = allSearchParams.platform

  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // Intentionally swallowed: malformed URI encoding, use raw handle string as-is
  }

  // Phase 1: Resolve trader identity + find linked user account in parallel.
  // cachedResolveTrader deduplicates the DB query shared with generateMetadata.
  const [userHandle, resolved] = await Promise.all([
    cachedFindUserHandleByTrader(decodedHandle),
    cachedResolveTrader(decodedHandle, platform),
  ])

  // If not found, 404
  if (!resolved) {
    notFound()
  }

  // Redirect raw address URLs to human-readable handle URLs (better SEO)
  if (resolved.handle && resolved.handle !== decodedHandle) {
    const redirectParams = new URLSearchParams({ platform: resolved.platform })
    // Preserve any additional query params (e.g. UTM tracking)
    for (const [key, val] of Object.entries(allSearchParams)) {
      if (key !== 'platform' && val) redirectParams.set(key, val)
    }
    redirect(`/trader/${encodeURIComponent(resolved.handle)}?${redirectParams.toString()}`)
  }

  // Phase 2: Fetch trader detail + claimed user profile in parallel.
  // cachedGetTraderDetail serves the ~11-query fetch from Next.js data cache.
  const userProfilePromise = userHandle
    ? getSupabaseAdmin()
        .from('user_profiles')
        .select('id, handle, bio, avatar_url, cover_url')
        .eq('handle', userHandle)
        .maybeSingle()
        .then(({ data }) => data as { id: string; handle: string; bio?: string | null; avatar_url?: string | null; cover_url?: string | null } | null)
    : Promise.resolve(null as null)

  const [detailResult, claimedUserProfile] = await Promise.all([
    cachedGetTraderDetail(resolved.platform, resolved.traderKey).catch(() => null),
    userProfilePromise,
  ])

  const serverTraderData = detailResult ? toTraderPageData(detailResult) : null

  // Build UnregisteredTraderData for initial render
  const platformDead = isDead(resolved.platform)
  const traderData: UnregisteredTraderData = {
    handle: resolved.handle || decodedHandle,
    avatar_url: resolved.avatarUrl,
    source: resolved.platform,
    source_trader_id: resolved.traderKey,
    is_platform_dead: platformDead || undefined,
    // Pull basic scores from serverTraderData if available
    ...(serverTraderData?.performance ? {
      arena_score: (serverTraderData.performance as Record<string, unknown>).arena_score as number | null,
      roi: (serverTraderData.performance as Record<string, unknown>).roi_90d as number | null,
      pnl: (serverTraderData.performance as Record<string, unknown>).pnl as number | null,
      win_rate: (serverTraderData.performance as Record<string, unknown>).win_rate as number | null,
      max_drawdown: (serverTraderData.performance as Record<string, unknown>).max_drawdown as number | null,
      rank: (serverTraderData.performance as Record<string, unknown>).rank as number | null,
      profitability_score: (serverTraderData.performance as Record<string, unknown>).profitability_score as number | null,
      risk_control_score: (serverTraderData.performance as Record<string, unknown>).risk_control_score as number | null,
      execution_score: (serverTraderData.performance as Record<string, unknown>).execution_score as number | null,
      sortino_ratio: (serverTraderData.performance as Record<string, unknown>).sortinoRatio as number | null ?? null,
      calmar_ratio: (serverTraderData.performance as Record<string, unknown>).calmarRatio as number | null ?? null,
      profit_factor: (serverTraderData.performance as Record<string, unknown>).profitFactor as number | null ?? null,
    } : {}),
  }

  // JSON-LD structured data — use centralized schema generator
  const traderSchemaInput: TraderSchemaInput = {
    handle: traderData.handle,
    id: traderData.source_trader_id ?? decodedHandle,
    bio: undefined,
    avatarUrl: traderData.avatar_url ?? undefined,
    source: resolved.platform,
    roi90d: traderData.roi ?? undefined,
    winRate: traderData.win_rate ?? undefined,
    arenaScore: traderData.arena_score ?? undefined,
  }
  const jsonLd = generateTraderProfilePageSchema(traderSchemaInput)

  return (
    <>
      <JsonLd data={jsonLd} />
      <ErrorBoundary pageType="trader-profile">
        <TraderProfileClient data={traderData} serverTraderData={serverTraderData as import('@/app/u/[handle]/components/types').TraderPageData | null} claimedUser={claimedUserProfile} />
      </ErrorBoundary>
    </>
  )
}
