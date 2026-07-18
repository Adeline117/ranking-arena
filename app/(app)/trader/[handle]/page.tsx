import type { Metadata } from 'next'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { notFound } from 'next/navigation'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { ErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { isDeadPlatform } from '@/lib/constants/exchanges'
import { isRetiredSource } from '@/lib/constants/retired-sources'
import { getDataMode } from '@/lib/constants/serving-cutover'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getFirstScreen } from '@/lib/data/serving/first-screen'
import { fetchSimilarTraders } from '@/lib/data/trader/similar'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import { LR } from '@/lib/types/schema-mapping'
import { BASE_URL } from '@/lib/constants/urls'
import {
  generateTraderProfilePageSchema,
  generateBreadcrumbSchema,
  type TraderSchemaInput,
} from '@/lib/seo/structured-data'
import { SSR_QUERY_TIMEOUT_MS, SERVING_RESOLVE_TIMEOUT_MS } from '@/lib/constants/timeouts'
import { logger } from '@/lib/logger'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { findClaimedUserHandleByIdentity } from '@/lib/identity/claimed-trader'

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

// ---------------------------------------------------------------------------
// ARENA_DATA_SPEC v1.2 serving branch (spec §2.4-1): for sources cut over to
// the arena.* read path, the first screen comes from ONE RPC (identity +
// latest passing board entries) instead of the legacy ~11-query detail
// fetch. Same caching + timeout scaffolding as the legacy path.
// ---------------------------------------------------------------------------

const cachedServingResolveISR = unstable_cache(
  async (handle: string, source: string | undefined) => {
    const result = await resolveServingTrader(getReadReplica(), { handle, source })
    if (!result) throw new Error('TRADER_RESOLVE_NULL') // never cache null
    return result
  },
  ['trader-serving-resolve'],
  { revalidate: 300, tags: ['trader-profile'] }
)

// Sentinel for "the cached/replica path TIMED OUT" — distinct from a genuine
// null (trader not found). ROOT-CAUSE FIX (2026-06-15): a timeout here used to
// collapse to null → the body fell into legacy mode → notFound() → a VALID
// serving trader got a route-cached "Trader Not Found" for 5 min. Observed on
// okx: curl (single request) resolved 10/10, but a real browser failed ~every
// time — the page render competes with its OWN concurrent asset/prefetch
// requests for a pooled connection, and acquisition (not the ~0.1s RPC) blew
// the tight 3s budget. Two defenses: (1) a generous SERVING_RESOLVE_TIMEOUT_MS
// ceiling so slow connection-acquisition still completes (a genuine not-found
// returns fast — the ISR wrapper throws immediately on null), and (2) one
// direct retry on timeout, bypassing the contended unstable_cache layer.
const SERVING_RESOLVE_TIMEOUT = Symbol('serving-resolve-timeout')

const cachedServingResolve = cache(async (handle: string, source?: string) => {
  try {
    const raced = await Promise.race([
      cachedServingResolveISR(handle, source),
      new Promise<typeof SERVING_RESOLVE_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(SERVING_RESOLVE_TIMEOUT), SERVING_RESOLVE_TIMEOUT_MS)
      ),
    ])
    if (raced !== SERVING_RESOLVE_TIMEOUT) return raced
  } catch (err) {
    if (err instanceof Error && err.message === 'TRADER_RESOLVE_NULL') return null
    logger.error(
      '[trader/page] resolveServingTrader failed:',
      err instanceof Error ? err.message : err
    )
    return null
  }

  // Timed out: one direct retry, bypassing the (contended) unstable_cache layer.
  try {
    return await Promise.race([
      resolveServingTrader(getReadReplica(), { handle, source }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SERVING_RESOLVE_TIMEOUT_MS)),
    ])
  } catch (err) {
    logger.error(
      '[trader/page] serving resolve retry failed:',
      err instanceof Error ? err.message : err
    )
    return null
  }
})

const cachedGetFirstScreenISR = unstable_cache(
  async (source: string, traderId: string) => {
    const result = await getFirstScreen(getReadReplica(), source, traderId)
    if (!result) throw new Error('TRADER_DETAIL_NULL') // never cache null
    return result
  },
  ['trader-first-screen'],
  { revalidate: 300, tags: ['trader-profile'] }
)

const cachedGetFirstScreen = async (
  source: string,
  traderId: string
): Promise<TraderFirstScreen | null> => {
  try {
    return await Promise.race([
      cachedGetFirstScreenISR(source, traderId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_DETAIL_TIMEOUT_MS)),
    ])
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg !== 'TRADER_DETAIL_NULL') {
      logger.error('[trader/page] getFirstScreen failed:', msg)
    }
    return null
  }
}

// Capability matrix is near-static (spec §6) — 1h revalidate, best-effort.
const cachedCapabilitiesISR = unstable_cache(
  async () => getSourceCapabilities(getReadReplica()),
  ['arena-source-capabilities'],
  { revalidate: 3600 }
)
const cachedCapabilities = async () => {
  try {
    return await Promise.race([
      cachedCapabilitiesISR(),
      new Promise<Record<string, never>>((resolve) => setTimeout(() => resolve({}), 2_000)),
    ])
  } catch {
    return {}
  }
}

// Per-timeframe Arena Score sub-scores + trading style for the serving path.
// The serving three-tab data (arena_core_modules) carries raw stats only —
// ScoreBreakdownSection and the header style tag were EMPTY in serving mode
// (2026-07-09 audit) even though leaderboard_ranks has all these columns.
const cachedServingScores = unstable_cache(
  async (platform: string, traderKey: string) => {
    const { data } = await getReadReplica()
      .from('leaderboard_ranks')
      .select(
        'season_id, arena_score, arena_score_v3, profitability_score, risk_control_score, execution_score, score_completeness, trading_style, style_confidence, avg_holding_hours'
      )
      .eq(LR.source, platform)
      .eq(LR.source_trader_id, traderKey)
      .in(LR.season_id, ['7D', '30D', '90D'])
    return data ?? []
  },
  ['trader-serving-scores'],
  { revalidate: 300, tags: ['trader-profile'] }
)

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

// Cached user handle lookup for one exact claimed exchange account. Raw trader
// IDs and handles collide across sources, so this function must never start
// from the URL handle or pick the first matching trader_sources row.
const cachedFindUserHandleByTrader = unstable_cache(
  async (source: string, traderId: string): Promise<string | null> => {
    try {
      return await findClaimedUserHandleByIdentity(getReadReplica(), { source, traderId })
    } catch {
      return null
    }
  },
  ['trader-user-handle-by-source-and-id-v2'],
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
  // Serving-only traders (arena.* read path, spec §2.4) may not exist in the
  // legacy tables — check the serving resolver before 404ing.
  let servingMeta: Awaited<ReturnType<typeof cachedServingResolve>> = null
  if (resolved === null) {
    servingMeta = await cachedServingResolve(decoded)
    if (!servingMeta || (await getDataMode(servingMeta.source)) !== 'serving') {
      notFound()
    }
  }

  const isUnavailable = resolved === RESOLVE_UNAVAILABLE
  const resolvedData = (isUnavailable ? null : resolved) as Exclude<
    ResolveResult,
    typeof RESOLVE_UNAVAILABLE
  >

  // Retired sources (spec-dropped, archived to arena_archive) are removed from
  // the product → 404. Done HERE in generateMetadata (before Suspense streaming)
  // so the response is a clean 404 without conflicting robots meta — same
  // rationale as the serving-null notFound above.
  //
  // ROOT-CAUSE FIX (2026-06-15): the SAME exchange_trader_id can exist in legacy
  // trader_sources under MULTIPLE sources — including a RETIRED one (e.g.
  // okx_web3) alongside a LIVE serving one (okx_futures). The legacy resolver
  // has no ORDER BY, so under a different query plan (e.g. a browser's concurrent
  // requests vs a lone curl) it non-deterministically returns the retired row →
  // this check 404'd a perfectly valid serving trader. So: only 404 a retired
  // legacy platform if the id does NOT also resolve to a live serving source.
  if (resolvedData && isRetiredSource(resolvedData.platform)) {
    const servingFallback = servingMeta ?? (await cachedServingResolve(decoded))
    if (!servingFallback || (await getDataMode(servingFallback.source)) !== 'serving') {
      notFound()
    }
  }

  const name = resolvedData?.handle || servingMeta?.nickname || decoded
  const exchange = resolvedData
    ? EXCHANGE_DISPLAY[resolvedData.platform] || resolvedData.platform || 'Crypto'
    : servingMeta
      ? EXCHANGE_DISPLAY[servingMeta.source] || servingMeta.source
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

  // Root layout template appends ' | Arena', so the metadata title must NOT
  // include it (else the tab/SEO title doubles to '… | Arena | Arena').
  // OG/Twitter titles are NOT run through the template, so they keep the suffix.
  const title = `${name} — Performance & Stats`
  const ogTitle = `${title} | Arena`
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

  // Single canonical per trader (2026-07-11 SEO 审计:此前 canonical=原始请求段,
  // 同一交易员经 /trader/{id} vs /trader/{handle} 各自 self-canonical → 重复内容)。
  // ASCII handles remain the readable canonical path; non-ASCII handles use
  // the stable exchange-local ID because Vercel has historically rejected some
  // encoded multi-byte paths. **必须带 ?platform=**:同 handle/id 跨
  // okx_futures/okx_spot 等多账号,裸形式会合并不同交易员。页面不再在 ISR
  // server 中重定向，因为 server 看不到 query variant；canonical 由 metadata
  // 表达，认领账户的 /u/ 跳转则在客户端核对复合身份后执行。
  const canonicalPath = resolvedData
    ? `/trader/${encodeURIComponent(
        /^[a-zA-Z0-9_.-]+$/.test(resolvedData.handle || '')
          ? resolvedData.handle!
          : resolvedData.traderKey
      )}?platform=${encodeURIComponent(resolvedData.platform)}`
    : `/trader/${encodeURIComponent(decoded)}`
  const canonicalUrl = `${BASE}${canonicalPath}`

  return {
    title,
    description,
    openGraph: {
      title: ogTitle,
      description,
      url: canonicalUrl,
      siteName: 'Arena',
      type: 'profile',
      images: [
        { url: ogImageUrl, width: 1200, height: 630, alt: `${name} trading performance card` },
      ],
    },
    twitter: {
      card: 'summary_large_image',
      title: ogTitle,
      description: description.length > 160 ? description.substring(0, 157) + '...' : description,
      images: [ogImageUrl],
      creator: '@arenafi',
      site: '@arenafi',
    },
    alternates: { canonical: canonicalUrl },
  }
}

// ISR: regenerate trader pages every 5 minutes
export const revalidate = 300

export default async function TraderPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params
  if (handle.length > 300) notFound()

  // NOTE: searchParams removed from server component to fix DYNAMIC_SERVER_USAGE error.
  // Accessing searchParams in a page with generateStaticParams + revalidate causes
  // Next.js 16 to throw at runtime because it conflicts with ISR static generation —
  // one cached HTML serves EVERY ?platform= variant, so the param cannot affect
  // server rendering at all. Both resolvers below therefore run WITHOUT a platform
  // hint and pick an account automatically; when the URL carries ?platform= for a
  // DIFFERENT account sharing this handle (e.g. okx_futures vs okx_spot share an
  // exchange_trader_id), TraderProfileClient detects the mismatch, validates the
  // platform via /api/traders/[handle]/first-screen, and switches the whole page
  // (header + capability + /core + /records) onto that account client-side.

  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // Intentionally swallowed: malformed URI encoding, use raw handle string as-is
  }

  // Phase 1 resolves an account before looking up claim ownership. A display
  // handle alone is not an identity: the same raw value can exist on many
  // sources. cachedResolveTrader deduplicates the query shared with metadata.
  const resolved = await cachedResolveTrader(decodedHandle)

  // ── ARENA_DATA_SPEC v1.2 serving branch (spec §2.4-1) ──
  // ROOT-CAUSE FIX (2026-06-12): ALWAYS consult the arena (serving) resolver and
  // let a serving-mode match WIN over the legacy resolver.
  //
  // Why: the legacy `trader_sources` table still holds stale rows keyed by the
  // same exchange_trader_id/handle as a live serving trader (e.g. id "3355"
  // exists for legacy `xt`/`lbank`/`gateio` AND serving `gate_futures`; the
  // bybit copytrade id exists for both legacy `bybit_spot` and serving
  // `bybit_copytrade`). The old code consulted the serving resolver ONLY when
  // the legacy resolver returned null or already pointed at a serving source —
  // so a stale legacy match to a NON-serving source (xt/bybit_spot) shadowed the
  // correct serving trader, the page rendered in legacy mode, and the client
  // fetched /api/traders/{wrongHandle}?source={staleSource} → 404 → full-page
  // "Trader Not Found" over an HTTP-200 page.
  //
  // The arena resolver (arena_resolve_trader) is authoritative for serving
  // sources, so if it returns a serving-mode trader for this handle we use it
  // unconditionally. This guarantees NO stale legacy row can ever shadow a live
  // serving trader, for any source, present or future.
  let servingResolved: Awaited<ReturnType<typeof cachedServingResolve>> = null
  {
    // Only pass the legacy platform as a source hint when it is ITSELF a serving
    // source. arena_resolve_trader(handle, hint) returns NOTHING when the hint is
    // a stale non-serving source (e.g. "xt"/"bybit_spot") even though the handle
    // resolves cleanly with no hint — so a stale legacy hint would defeat the
    // whole fix. Resolving by handle alone lets the RPC pick the serving trader.
    const legacyPlatform =
      resolved && resolved !== RESOLVE_UNAVAILABLE ? resolved.platform : undefined
    const hint =
      legacyPlatform && (await getDataMode(legacyPlatform)) === 'serving'
        ? legacyPlatform
        : undefined
    const sr = await cachedServingResolve(decodedHandle, hint)
    if (sr && (await getDataMode(sr.source)) === 'serving') servingResolved = sr
  }

  if (servingResolved) {
    const [firstScreenRaw, capabilities, userHandle] = await Promise.all([
      cachedGetFirstScreen(servingResolved.source, servingResolved.exchangeTraderId),
      cachedCapabilities(),
      cachedFindUserHandleByTrader(servingResolved.source, servingResolved.exchangeTraderId),
    ])

    // ROOT-CAUSE FIX (2026-06-11): a serving-only trader (exists only in arena.*,
    // not in legacy trader_sources/leaderboard_ranks) MUST NEVER fall through to
    // the legacy /api/traders endpoint — that endpoint 404s for serving sources,
    // and the client then renders a full-page "Trader Not Found" even though the
    // page itself returned HTTP 200. The previous code passed
    // servingFirstScreen={null} on first-screen timeout, which flipped the client
    // back into legacy mode. Instead, synthesize a minimal first-screen from the
    // already-resolved identity so the client stays in serving mode and lets
    // ServingProfilePanel fetch /core on its own (with its own skeletons + Tier-C
    // background fetch). entries=[] is a valid empty board, not a missing trader.
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

    // Tier-A hero numbers: prefer the 90d board entry (matches rankings).
    const entries = firstScreen.entries ?? []
    const best =
      entries.find((e) => e.timeframe === 90) ??
      entries.find((e) => e.timeframe === 30) ??
      entries[0]
    const bestWinRate =
      best?.headlineWinRate ??
      (typeof best?.extras.win_rate === 'number' ? (best.extras.win_rate as number) : null)

    const verifiedKeys = await getVerifiedTraderKeys(getReadReplica())
    const servingTraderData: UnregisteredTraderData = {
      handle: firstScreen.nickname ?? servingResolved.nickname ?? decodedHandle,
      // Spec §1.4 avatar chain: mirror direct → proxied origin → null
      // (null → client renders gradient + initial fallback).
      avatar_url:
        firstScreen.avatarSrc ??
        getTraderAvatarSrc({
          avatarMirrorUrl: servingResolved.avatarMirrorUrl,
          avatarOriginUrl: servingResolved.avatarOriginUrl,
        }),
      source: servingResolved.source,
      source_trader_id: servingResolved.exchangeTraderId,
      rank: best?.rank ?? null,
      roi: best?.headlineRoi ?? null,
      pnl: best?.headlinePnl?.value ?? null,
      win_rate: bestWinRate,
      max_drawdown: typeof best?.extras.mdd === 'number' ? (best.extras.mdd as number) : null,
      is_verified_data: verifiedKeys.has(
        verifiedTraderKey(servingResolved.source, servingResolved.exchangeTraderId)
      ),
    }

    // U2-12: similar-traders module regression. The serving three-tab data path
    // (useServingTabData → /core) never carried similarTraders, so OverviewTab's
    // `traderSimilar.length > 0` guard permanently hid the module for serving
    // sources (the default). Legacy path fed it via bridge.ts; serving didn't.
    // Fix: compute it once here server-side (fetchSimilarTraders is Redis-cached,
    // 15min warm) using the 90d board score/roi, map to the OverviewTab shape
    // (same shape as bridge.ts:203), and thread it down as serverSimilarTraders.
    // Per-TF sub-scores + style for ScoreBreakdown/header (best-effort, 2s cap).
    const servingScores = await Promise.race([
      cachedServingScores(servingResolved.source, servingResolved.exchangeTraderId).catch((e) => {
        logger.warn('[trader/page] cachedServingScores failed', {
          source: servingResolved.source,
          error: String(e),
        })
        return []
      }),
      new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 2_000)),
    ])

    const similarScoreExtra = best?.extras.arena_score
    const similarArenaScore = typeof similarScoreExtra === 'number' ? similarScoreExtra : null
    const serverSimilarTraders = (
      await fetchSimilarTraders(
        getReadReplica(),
        servingResolved.source,
        servingResolved.exchangeTraderId,
        similarArenaScore,
        servingTraderData.roi ?? null
      ).catch((e) => {
        logger.warn('[trader/page] fetchSimilarTraders failed', {
          source: servingResolved.source,
          error: String(e),
        })
        return []
      })
    ).map((st) => ({
      handle: st.handle || st.traderKey,
      id: st.traderKey,
      followers: st.followers ?? 0,
      avatar_url: st.avatarUrl ?? undefined,
      source: st.platform,
      roi_90d: st.roi ?? undefined,
      arena_score: st.arenaScore ?? undefined,
    }))

    const servingJsonLd = generateTraderProfilePageSchema({
      handle: servingTraderData.handle,
      id: servingResolved.exchangeTraderId,
      bio: undefined,
      avatarUrl: servingTraderData.avatar_url ?? undefined,
      source: servingResolved.source,
      roi90d: servingTraderData.roi ?? undefined,
      winRate: servingTraderData.win_rate ?? undefined,
    })
    const servingBreadcrumb = generateBreadcrumbSchema([
      { name: 'Arena', url: BASE_URL },
      { name: 'Rankings', url: `${BASE_URL}/rankings` },
      {
        name: servingTraderData.handle,
        url: `${BASE_URL}/trader/${encodeURIComponent(decodedHandle)}`,
      },
    ])

    // servingFirstScreen is now ALWAYS non-null for serving sources (synthesized
    // above on timeout), so the client stays in serving mode and never falls back
    // to the legacy 404 path. ServingProfilePanel fetches /core for the body.
    return (
      <>
        <JsonLd data={servingJsonLd} />
        <JsonLd data={servingBreadcrumb} />
        <ErrorBoundary pageType="trader-profile">
          <TraderProfileClient
            data={servingTraderData}
            serverTraderData={null}
            claimedUser={null}
            claimedTraderIdentity={
              userHandle
                ? {
                    source: servingResolved.source,
                    traderId: servingResolved.exchangeTraderId,
                    userHandle,
                  }
                : null
            }
            dataMode="serving"
            servingFirstScreen={firstScreen}
            servingCapability={capabilities[servingResolved.source] ?? null}
            serverSimilarTraders={serverSimilarTraders}
            servingScores={servingScores}
          />
        </ErrorBoundary>
      </>
    )
  }

  // notFound() handled in generateMetadata() — do NOT call here.
  // Calling notFound() inside a page component triggers Next.js Suspense
  // to inject <meta name="robots" content="noindex"/> for ALL pages,
  // even valid ones. generateMetadata runs before streaming starts.
  if (!resolved || resolved === RESOLVE_UNAVAILABLE) return null

  // Retired source → generateMetadata already issued the 404; render nothing
  // here (return null, NOT notFound(), to avoid the page-level noindex bug).
  if (isRetiredSource(resolved.platform)) return null

  // Phase 2: Fetch trader detail.
  // cachedGetTraderDetail serves the ~11-query fetch from Next.js data cache;
  // claim ownership is looked up in parallel by the resolved composite identity.
  const claimedUserProfile = null

  const [detailResult, userHandle] = await Promise.all([
    cachedGetTraderDetail(resolved.platform, resolved.traderKey).catch((err) => {
      // Log real fetch failures so they aren't silently masked as "no data".
      // cachedGetTraderDetail already handles TRADER_DETAIL_NULL internally;
      // errors reaching here are unexpected (e.g. network/timeout).
      logger.error(
        '[trader/page] cachedGetTraderDetail unexpected error:',
        err instanceof Error ? err.message : err
      )
      return null
    }),
    cachedFindUserHandleByTrader(resolved.platform, resolved.traderKey),
  ])

  const serverTraderData = detailResult ? toTraderPageData(detailResult) : null

  // Build UnregisteredTraderData for initial render
  const platformDead = isDeadPlatform(resolved.platform)
  const verifiedKeys = await getVerifiedTraderKeys(getReadReplica())
  const traderData: UnregisteredTraderData = {
    handle: resolved.handle || decodedHandle,
    avatar_url: resolved.avatarUrl,
    source: resolved.platform,
    source_trader_id: resolved.traderKey,
    is_platform_dead: platformDead || undefined,
    is_verified_data: verifiedKeys.has(verifiedTraderKey(resolved.platform, resolved.traderKey)),
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
          claimedTraderIdentity={
            userHandle
              ? {
                  source: resolved.platform,
                  traderId: resolved.traderKey,
                  userHandle,
                }
              : null
          }
        />
      </ErrorBoundary>
    </>
  )
}
