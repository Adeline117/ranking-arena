import type { Metadata } from 'next'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { redirect, notFound } from 'next/navigation'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { ErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { isDead } from '@/lib/connectors/route-config'
import { LR } from '@/lib/types/schema-mapping'
import { BASE_URL } from '@/lib/constants/urls'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  type TraderSchemaInput,
} from '@/lib/seo/structured-data'
import { SSR_QUERY_TIMEOUT_MS } from '@/lib/constants/timeouts'
import { logger } from '@/lib/logger'

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
    const result = await resolveTrader(getReadReplica(), { handle, platform })
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
//
// Timeout (3s): during compute-leaderboard cron contention, resolveTrader
// can take 30+ seconds (the underlying queries against `traders` and
// `leaderboard_ranks` block on the same row locks the cron is upserting).
// Without a timeout, the ENTIRE page.tsx await chain stalls at the resolve
// step and the user sees an indefinite hang. With a 3s timeout, slow paths
// resolve to null → page.tsx calls notFound() → user sees a fast 404 instead.
// Stale cached resolves still hit the unstable_cache layer immediately.
//
// AbortSignal.timeout actually cancels the underlying HTTP request to
// PostgREST, freeing the connection. Promise.race just abandons it.
// Sentinel to distinguish "not found" from "timed out / error".
// ROOT-ROOT CAUSE FIX: Previously both returned null → 404.
// Now timeout/error returns RESOLVE_UNAVAILABLE → generateMetadata skips notFound()
// and lets the page render with client-side retry (TraderProfileClient).
const RESOLVE_UNAVAILABLE = Symbol('unavailable')
type ResolveResult =
  | Awaited<ReturnType<typeof cachedResolveTraderISR>>
  | null
  | typeof RESOLVE_UNAVAILABLE

const cachedResolveTrader = cache(
  async (handle: string, platform?: string): Promise<ResolveResult> => {
    try {
      const result = await Promise.race([
        cachedResolveTraderISR(handle, platform),
        new Promise<typeof RESOLVE_UNAVAILABLE>((resolve) =>
          setTimeout(() => resolve(RESOLVE_UNAVAILABLE), SSR_QUERY_TIMEOUT_MS)
        ),
      ])
      return result
    } catch (err) {
      // TRADER_RESOLVE_NULL = trader genuinely not found (thrown to prevent unstable_cache
      // from caching null). Convert to null so callers can check normally.
      if (err instanceof Error && err.message === 'TRADER_RESOLVE_NULL') {
        return null
      }
      // Real DB failures — return unavailable so page doesn't 404 valid traders
      logger.error('[trader/page] resolveTrader failed:', err instanceof Error ? err.message : err)
      return RESOLVE_UNAVAILABLE
    }
  }
)

// Heavy query (~11 parallel DB queries). Caching this eliminates the dominant
// TTFB contribution on repeat requests (expected: 973ms -> <200ms on cache hit).
// Null results throw to prevent unstable_cache from persisting "no data" for 5min.
const cachedGetTraderDetailISR = unstable_cache(
  async (platform: string, traderKey: string) => {
    const result = await getTraderDetail(getReadReplica(), { platform, traderKey })
    if (!result) throw new Error('TRADER_DETAIL_NULL')
    return result
  },
  ['trader-detail'],
  { revalidate: 300, tags: ['trader-profile'] }
)

// SSR hard timeout — must complete within the SSR budget or page renders
// without detail data. Without this, during compute-leaderboard cron
// contention the underlying queries spike to 15-30s, the entire page.tsx
// await chain blocks, and Next.js never streams past the Suspense placeholders.
// Search bots see <main><!--$?--><template id="B:1"></template><!--/$--></main>
// with NO content and NO JSON-LD. Falling back to null lets the page
// render the SSR shell + JsonLd immediately, and TraderProfileClient
// fetches fresh data client-side.
//
// NOTE: The individual queries inside getTraderDetail now carry their own
// AbortSignal.timeout (SSR_HEAVY_QUERY_TIMEOUT_MS) which actually cancels
// the HTTP request. This outer Promise.race is a safety net only.
const SSR_DETAIL_TIMEOUT_MS = SSR_QUERY_TIMEOUT_MS + 1000 // 4s: 1s headroom over inner AbortSignal
const cachedGetTraderDetail = async (platform: string, traderKey: string) => {
  try {
    return await Promise.race([
      cachedGetTraderDetailISR(platform, traderKey),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_DETAIL_TIMEOUT_MS)),
    ])
  } catch (err) {
    // TRADER_DETAIL_NULL is expected (thrown by cachedGetTraderDetailISR to avoid
    // caching null results). Other errors are real DB failures — log but return
    // null to let client-side fetch retry.
    const msg = err instanceof Error ? err.message : ''
    if (msg !== 'TRADER_DETAIL_NULL') {
      logger.error('[trader/page] getTraderDetail failed:', msg)
    }
    return null
  }
}

// Cached leaderboard query for OG metadata.
// Avoids a duplicate DB query between generateMetadata and the page render.
const cachedLeaderboardMeta = unstable_cache(
  async (platform: string, traderKey: string) => {
    const { data } = await getReadReplica()
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
      const supabase = getReadReplica()
      // Find trader identity by handle, then check for active authorization
      const { data: sources } = await supabase
        .from('trader_sources')
        .select('source, source_trader_id')
        .eq('handle', traderHandle)
        .limit(10)

      if (!sources?.length) return null

      for (const src of sources) {
        const { data: auth } = await supabase
          .from('trader_authorizations')
          .select('user_profiles:user_id(handle)')
          .eq('platform', src.source)
          .eq('trader_id', src.source_trader_id)
          .eq('status', 'active')
          .maybeSingle()

        if (auth?.user_profiles) {
          const profile = auth.user_profiles as unknown as { handle: string | null } | null
          return profile?.handle || null
        }
      }
      return null
    } catch {
      return null
    }
  },
  ['trader-user-handle'],
  { revalidate: 300, tags: ['trader-profile'] }
)

/**
 * Pre-render top 500 trader pages at build time for faster TTFB and better SEO.
 * Non-pre-rendered handles still work at runtime (dynamicParams = true).
 */
// generateStaticParams REMOVED — its presence causes Vercel to treat
// /trader/[handle] as an ISR route with special routing that rejects
// non-ASCII percent-encoded paths (returns x-matched-path: /500).
// Without it, the route is fully dynamic and Chinese handles work.
// Performance impact is minimal: ISR cache (revalidate=300) still works
// for the first visitor of each handle; only build-time pre-rendering is lost.

export async function generateMetadata({
  params,
}: {
  params: Promise<{ handle: string }>
}): Promise<Metadata> {
  const { handle } = await params
  // Reject absurdly long handles early to prevent cache key bloat and DB abuse
  if (handle.length > 300) return notFound()

  let decoded: string
  try {
    decoded = decodeURIComponent(handle)
  } catch {
    decoded = handle
  }
  const BASE = BASE_URL

  // ---------- resolve trader identity ----------
  let resolved: Awaited<ReturnType<typeof cachedResolveTrader>> = null
  try {
    resolved = await cachedResolveTrader(decoded)
  } catch (err) {
    if (err && typeof err === 'object' && 'digest' in err) throw err
    logger.error(
      '[trader/generateMetadata] resolveTrader failed:',
      decoded,
      err instanceof Error ? err.message : err
    )
  }

  // ROOT CAUSE FIX (2026-04-23): calling notFound() in the page component
  // (inside Suspense) caused Next.js to inject <meta name="robots" content="noindex"/>
  // alongside the page's own "index, follow" meta tag. Google picks the most
  // restrictive directive, so ALL 34k trader pages were effectively de-indexed.
  // Fix: call notFound() HERE in generateMetadata() so it executes BEFORE
  // Suspense streaming starts, producing a clean 404 without conflicting meta tags.
  // Only 404 when genuinely not found. Timeout/error → return generic metadata
  // and let client-side retry. This prevents valid traders from being 404'd
  // during cron contention and de-indexed by Google.
  if (resolved === null) {
    notFound()
  }

  const isUnavailable = resolved === RESOLVE_UNAVAILABLE
  const resolvedData = (isUnavailable ? null : resolved) as Exclude<
    ResolveResult,
    typeof RESOLVE_UNAVAILABLE
  >
  const name = resolvedData?.handle || decoded
  const exchange = resolvedData
    ? EXCHANGE_DISPLAY[resolvedData.platform] || resolvedData.platform || 'Crypto'
    : 'Crypto'

  // ---------- fetch leaderboard stats (best-effort, never fails metadata) ----------
  let lr: {
    rank?: number | null
    arena_score?: number | null
    roi?: number | null
    pnl?: number | null
  } | null = null
  if (resolvedData) {
    try {
      lr = await cachedLeaderboardMeta(resolvedData.platform, resolvedData.traderKey)
    } catch (err) {
      // Leaderboard fetch failure should NOT prevent title generation.
      // The trader name is already known — produce metadata without stats.
      logger.error(
        '[trader/generateMetadata] leaderboardMeta failed:',
        decoded,
        err instanceof Error ? err.message : err
      )
    }
  }

  const roi = typeof lr?.roi === 'number' ? lr.roi : null
  const score = typeof lr?.arena_score === 'number' ? lr.arena_score : null
  const rank = lr?.rank ?? null

  const parts = [
    roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null,
    score != null ? `Arena Score ${score.toFixed(0)}` : null,
    rank != null ? `Ranked ${rank}` : null,
  ].filter(Boolean)

  const pnl = typeof lr?.pnl === 'number' ? lr.pnl : null

  const title = `${name} — Performance & Stats | Arena`
  const rawDescription = parts.length
    ? `${name} is a ${exchange} trader with ${parts.join(', ')}${pnl != null ? `. PnL: $${pnl >= 0 ? '+' : ''}${pnl >= 1000 || pnl <= -1000 ? (pnl / 1000).toFixed(1) + 'K' : pnl.toFixed(0)}` : ''}. Track performance history, analytics, and rankings on Arena.`
    : `${name} is a ${exchange} crypto trader. View performance analytics, trading history, risk metrics, and rankings on Arena.`
  const description =
    rawDescription.length > 160 ? rawDescription.substring(0, 157) + '...' : rawDescription

  const ogParams = new URLSearchParams({ handle: decoded })
  if (roi != null) ogParams.set('roi', roi.toFixed(2))
  if (score != null) ogParams.set('score', score.toFixed(0))
  if (rank != null) ogParams.set('rank', String(rank))
  if (resolvedData?.platform) ogParams.set('source', resolvedData.platform)
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
      images: [
        { url: ogImageUrl, width: 1200, height: 630, alt: `${name} trading performance card` },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description: description.length > 160 ? description.substring(0, 157) + '...' : description,
      images: [ogImageUrl],
      creator: '@arenafi',
      site: '@arenafi',
    },
    alternates: { canonical: `${BASE}/trader/${encodeURIComponent(decoded)}` },
  }
}

// ISR: regenerate trader pages every 5 minutes
export const revalidate = 300

export default async function TraderPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params
  if (handle.length > 300) notFound()

  // NOTE: searchParams removed from server component to fix DYNAMIC_SERVER_USAGE error.
  // Accessing searchParams in a page with generateStaticParams + revalidate causes
  // Next.js 16 to throw at runtime because it conflicts with ISR static generation.
  // The ?platform= param for exchange disambiguation is handled client-side by
  // TraderProfileClient via useSearchParams(). resolveTrader without a platform hint
  // picks the highest-scored exchange automatically.

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
    cachedResolveTrader(decodedHandle),
  ])

  // notFound() handled in generateMetadata() — do NOT call here.
  // Calling notFound() inside a page component triggers Next.js Suspense
  // to inject <meta name="robots" content="noindex"/> for ALL pages,
  // even valid ones. generateMetadata runs before streaming starts.
  if (!resolved || resolved === RESOLVE_UNAVAILABLE) return null

  // Redirect claimed traders to canonical /u/ URL (avoids SEO duplicate content)
  if (userHandle) {
    redirect(`/u/${encodeURIComponent(userHandle)}`)
  }

  // Redirect raw address URLs to human-readable handle URLs (better SEO)
  // Skip redirect for non-ASCII handles (Chinese, Korean, etc.) — Vercel's
  // routing layer returns 500 for percent-encoded multi-byte UTF-8 paths.
  // Only redirect URL-safe handles (no spaces/commas). Handles like "The bigger the waves..."
  // cause redirect loops because resolveTrader cant find them by display name.
  const isAsciiHandle = resolved.handle && /^[a-zA-Z0-9_.-]+$/.test(resolved.handle)
  if (isAsciiHandle && resolved.handle! !== decodedHandle) {
    redirect(
      `/trader/${encodeURIComponent(resolved.handle!)}?platform=${encodeURIComponent(resolved.platform)}`
    )
  }

  // Phase 2: Fetch trader detail.
  // cachedGetTraderDetail serves the ~11-query fetch from Next.js data cache.
  // Note: userHandle is always falsy here (truthy case redirects above), so
  // claimedUserProfile is always null — no need to fetch user_profiles.
  const claimedUserProfile = null

  const detailResult = await cachedGetTraderDetail(resolved.platform, resolved.traderKey).catch(
    (err) => {
      // Log real fetch failures so they aren't silently masked as "no data".
      // cachedGetTraderDetail already handles TRADER_DETAIL_NULL internally;
      // errors reaching here are unexpected (e.g. network/timeout).
      logger.error(
        '[trader/page] cachedGetTraderDetail unexpected error:',
        err instanceof Error ? err.message : err
      )
      return null
    }
  )

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
    ...(serverTraderData?.performance
      ? {
          arena_score: (serverTraderData.performance as Record<string, unknown>).arena_score as
            | number
            | null,
          roi: (serverTraderData.performance as Record<string, unknown>).roi_90d as number | null,
          pnl: (serverTraderData.performance as Record<string, unknown>).pnl as number | null,
          win_rate: (serverTraderData.performance as Record<string, unknown>).win_rate as
            | number
            | null,
          max_drawdown: (serverTraderData.performance as Record<string, unknown>).max_drawdown as
            | number
            | null,
          rank: (serverTraderData.performance as Record<string, unknown>).rank as number | null,
          profitability_score: (serverTraderData.performance as Record<string, unknown>)
            .profitability_score as number | null,
          risk_control_score: (serverTraderData.performance as Record<string, unknown>)
            .risk_control_score as number | null,
          execution_score: (serverTraderData.performance as Record<string, unknown>)
            .execution_score as number | null,
          sortino_ratio: (serverTraderData.performance as Record<string, unknown>).sortinoRatio as
            | number
            | null,
          calmar_ratio: (serverTraderData.performance as Record<string, unknown>).calmarRatio as
            | number
            | null,
          profit_factor: (serverTraderData.performance as Record<string, unknown>).profitFactor as
            | number
            | null,
        }
      : {}),
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
  const breadcrumbJsonLd = generateBreadcrumbSchema([
    { name: 'Arena', url: BASE_URL },
    { name: 'Rankings', url: `${BASE_URL}/rankings` },
    { name: traderData.handle, url: `${BASE_URL}/trader/${encodeURIComponent(decodedHandle)}` },
  ])

  return (
    <>
      <JsonLd data={jsonLd} />
      <JsonLd data={breadcrumbJsonLd} />
      <ErrorBoundary pageType="trader-profile">
        <TraderProfileClient
          data={traderData}
          serverTraderData={
            serverTraderData as
              | import('@/app/(app)/u/[handle]/components/types').TraderPageData
              | null
          }
          claimedUser={claimedUserProfile}
        />
      </ErrorBoundary>
    </>
  )
}
