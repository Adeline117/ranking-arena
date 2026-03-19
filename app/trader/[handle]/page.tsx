import type { Metadata } from 'next'
import { cache } from 'react'
import { redirect, notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { ErrorBoundary } from '@/app/components/ui/ErrorBoundary'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'

// Deduplicate resolveTrader calls — both generateMetadata and the page component
// call resolveTrader with the same handle. React cache() ensures the DB query
// runs once per request, halving the number of round-trips to Supabase.
const cachedResolveTrader = cache(
  (handle: string, platform?: string) => resolveTrader(getSupabaseAdmin(), { handle, platform })
)

// Derive display names from central config
const EXCHANGE_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.name])
)

export async function generateMetadata({ params }: { params: Promise<{ handle: string }> }): Promise<Metadata> {
  const { handle } = await params
  const decoded = decodeURIComponent(handle)
  const BASE = 'https://www.arenafi.org'

  try {
    // Use cached resolver — deduplicates with the page component's resolveTrader call
    const resolved = await cachedResolveTrader(decoded)

    if (resolved) {
      // Fetch leaderboard data for OG meta
      const { data: lr } = await getSupabaseAdmin()
        .from('leaderboard_ranks')
        .select('rank, arena_score, roi, pnl')
        .eq('source', resolved.platform)
        .eq('source_trader_id', resolved.traderKey)
        .eq('season_id', '90D')
        .maybeSingle()

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

// Find the user profile associated with this trader handle
// Uses chained query: traders -> trader_authorizations -> user_profiles
async function findUserProfileByTraderHandle(traderHandle: string): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin()
    
    // Single query: find trader, then get active authorization with user profile
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
    // Fallback: single RPC-style query using trader_authorizations as the base
    // Joins trader_id→traders and user_id→user_profiles in one round-trip
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
}

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

  const sb = getSupabaseAdmin()

  // 并行查询注册用户和解析交易员身份
  // cachedResolveTrader deduplicates the DB query shared with generateMetadata
  const [userHandle, resolved] = await Promise.all([
    findUserProfileByTraderHandle(decodedHandle),
    cachedResolveTrader(decodedHandle, platform),
  ])

  // 1. If claimed, fetch the user profile to pass to the client component
  let claimedUserProfile: { id: string; handle: string; bio?: string | null; avatar_url?: string | null; cover_url?: string | null } | null = null
  if (userHandle) {
    const { data: userProfile } = await sb
      .from('user_profiles')
      .select('id, handle, bio, avatar_url, cover_url')
      .eq('handle', userHandle)
      .maybeSingle()
    claimedUserProfile = userProfile as typeof claimedUserProfile
  }

  // 2. 如果未找到交易员
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

  // 3. 获取完整交易员数据（通过统一数据层 — 自动处理 v1/v2/leaderboard fallback）
  let serverTraderData = null
  try {
    const detail = await getTraderDetail(sb, {
      platform: resolved.platform,
      traderKey: resolved.traderKey,
    })
    if (detail) {
      serverTraderData = toTraderPageData(detail)
    }
  } catch {
    // Intentionally swallowed: SSR trader detail fetch failed, client will retry via SWR
  }

  // Build UnregisteredTraderData for initial render
  const traderData: UnregisteredTraderData = {
    handle: resolved.handle || decodedHandle,
    avatar_url: resolved.avatarUrl,
    source: resolved.platform,
    source_trader_id: resolved.traderKey,
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

  // JSON-LD structured data
  const exchange = EXCHANGE_DISPLAY[resolved.platform] || resolved.platform || 'Crypto Exchange'
  const roi = traderData.roi ?? null
  const score = traderData.arena_score ?? null
  const rank = traderData.rank ?? null
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: traderData.handle,
    url: `https://www.arenafi.org/trader/${encodeURIComponent(traderData.handle)}`,
    ...(traderData.avatar_url ? { image: traderData.avatar_url } : {}),
    description: [
      `${exchange} crypto trader`,
      roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null,
      score != null ? `Arena Score ${score.toFixed(0)}` : null,
      rank != null ? `Ranked ${rank} on Arena` : null,
    ].filter(Boolean).join('. '),
    memberOf: { '@type': 'Organization', name: exchange },
    sameAs: [`https://www.arenafi.org/trader/${encodeURIComponent(traderData.handle)}`],
  }

  return (
    <>
      <JsonLd data={jsonLd} />
      <ErrorBoundary name="trader-profile">
        {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
        <TraderProfileClient data={traderData} serverTraderData={serverTraderData as any} claimedUser={claimedUserProfile} />
      </ErrorBoundary>
    </>
  )
}
