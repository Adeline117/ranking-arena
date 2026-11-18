import type { Metadata } from 'next'
import { cache } from 'react'
import { unstable_cache } from 'next/cache'
import { notFound } from 'next/navigation'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { JsonLd } from '@/app/components/Providers/JsonLd'
import { EXCHANGE_CONFIG } from '@/lib/constants/exchanges'
import TraderProfileClient, { type UnregisteredTraderData } from './TraderProfileClient'
import { ErrorBoundary } from '@/app/components/utils/ErrorBoundary'
import TraderNotFound from './not-found'
import { resolveTrader, getTraderDetail, toTraderPageData } from '@/lib/data/unified'
import { isDeadPlatform } from '@/lib/constants/exchanges'
import { isRetiredSource } from '@/lib/constants/retired-sources'
import { getDataMode } from '@/lib/constants/serving-cutover'
import { resolveServingTrader } from '@/lib/data/serving/resolve'
import { getPublicFirstScreen } from '@/lib/data/serving/first-screen'
import { headlineWindowFor } from '@/lib/data/serving/headline-window'
import { fetchSimilarTraders } from '@/lib/data/trader/similar'
import { getSourceCapabilities } from '@/lib/data/serving/capabilities'
import { getTraderAvatarSrc } from '@/lib/utils/avatar'
import type { TraderFirstScreen } from '@/lib/data/serving/types'
import { traderCanonicalPath } from '@/lib/seo/trader-url'
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
import {
  fetchPublicProfileRankingRows,
  PUBLIC_PROFILE_RANKING_PERIODS,
} from '@/lib/data/trader/public-profile-ranking'

// Derive display names from central config
const EXCHANGE_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(EXCHANGE_CONFIG).map(([k, v]) => [k, v.name])
)

// ---------------------------------------------------------------------------
// unstable_cache wrappers below are restricted to identity/capability lookups.
// Rank-bearing payloads intentionally bypass cross-request caches so each
// render observes the current sealed public cohort.
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
const getCurrentPublicTraderDetail = async (platform: string, traderKey: string) => {
  try {
    return await Promise.race([
      getTraderDetail(getReadReplica(), {
        platform,
        traderKey,
        publicProfileHistoryQuarantine: true,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_DETAIL_TIMEOUT_MS)),
    ])
  } catch (err) {
    // The reader itself returns null for an unresolvable profile; database
    // failures remain observable but must not block the page shell.
    const msg = err instanceof Error ? err.message : String(err)
    logger.error('[trader/page] getTraderDetail failed:', msg)
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

// A lookup that threw or timed out twice is UNAVAILABLE, not "no such trader".
// Callers that only need the row use cachedServingResolve (null either way);
// isMissingTrader must tell the two apart — a serving-only trader has no legacy
// row, so collapsing a contended lookup to null stamped valid traders with
// "Trader Not Found" + noindex.
const SERVING_RESOLVE_UNAVAILABLE = Symbol('serving-resolve-unavailable')

const cachedServingResolveOutcome = cache(async (handle: string, source?: string) => {
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
    return SERVING_RESOLVE_UNAVAILABLE
  }

  // Timed out: one direct retry, bypassing the (contended) unstable_cache layer.
  try {
    return await Promise.race([
      resolveServingTrader(getReadReplica(), { handle, source }),
      new Promise<typeof SERVING_RESOLVE_UNAVAILABLE>((resolve) =>
        setTimeout(() => resolve(SERVING_RESOLVE_UNAVAILABLE), SERVING_RESOLVE_TIMEOUT_MS)
      ),
    ])
  } catch (err) {
    logger.error(
      '[trader/page] serving resolve retry failed:',
      err instanceof Error ? err.message : err
    )
    return SERVING_RESOLVE_UNAVAILABLE
  }
})

const cachedServingResolve = cache(async (handle: string, source?: string) => {
  const outcome = await cachedServingResolveOutcome(handle, source)
  return outcome === SERVING_RESOLVE_UNAVAILABLE ? null : outcome
})

/**
 * Whether this handle has no public profile: unknown to both resolvers, or
 * known only under a retired source with no live serving account. A lookup
 * that timed out or failed is NOT missing — the page retries client-side.
 * Shared by generateMetadata and the page so both reach the same answer.
 */
const isMissingTrader = cache(async (decoded: string): Promise<boolean> => {
  const resolved = await cachedResolveTrader(decoded)
  if (resolved === RESOLVE_UNAVAILABLE) return false
  if (resolved && !isRetiredSource(resolved.platform)) return false
  const serving = await cachedServingResolveOutcome(decoded)
  if (serving === SERVING_RESOLVE_UNAVAILABLE) return false
  return !serving || (await getDataMode(serving.source)) !== 'serving'
})

// Metadata for a handle with no public profile. The page renders the
// not-found view in place (see TraderPage) instead of throwing notFound():
// metadata streams after the loading.tsx shell has already been sent with
// HTTP 200, so a late notFound() could only be applied by the browser — the
// server HTML carried no not-found content and React reported error #419.
const NOT_FOUND_METADATA: Metadata = {
  title: 'Trader Not Found',
  robots: { index: false, follow: false },
}

// The first-screen helper overlays current sealed rank/ROI authority. It must
// not sit behind an ISR cache: a withdrawn source has to disappear from the
// header on the next request instead of replaying a prior cohort.
const getCurrentPublicFirstScreen = async (
  source: string,
  traderId: string
): Promise<TraderFirstScreen | null> => {
  try {
    return await Promise.race([
      getPublicFirstScreen(getReadReplica(), source, traderId),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_DETAIL_TIMEOUT_MS)),
    ])
  } catch (err) {
    logger.error(
      '[trader/page] getCurrentPublicFirstScreen failed:',
      err instanceof Error ? err.message : String(err)
    )
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

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

// Per-timeframe Arena Score sub-scores + trading style for the serving path.
// The serving three-tab data (arena_core_modules) carries raw stats only.
// Rank-derived fields therefore come from the sealed public ranking cohort,
// where partial/estimated observations are absent rather than zero-filled.
async function getCurrentPublicServingScores(platform: string, traderKey: string) {
  const cohort = await fetchPublicProfileRankingRows(getReadReplica(), {
    source: platform,
    sourceTraderId: traderKey,
    periods: PUBLIC_PROFILE_RANKING_PERIODS,
  })
  return cohort.rows.map((row) => ({
    season_id: row.season_id,
    arena_score: finiteOrNull(row.arena_score),
    arena_score_v3: finiteOrNull(row.arena_score_v3),
    profitability_score: finiteOrNull(row.profitability_score),
    risk_control_score: finiteOrNull(row.risk_control_score),
    execution_score: finiteOrNull(row.execution_score),
    score_completeness:
      typeof row.score_completeness === 'string' || typeof row.score_completeness === 'number'
        ? row.score_completeness
        : null,
    trading_style: typeof row.trading_style === 'string' ? row.trading_style : null,
    style_confidence: finiteOrNull(row.style_confidence),
    avg_holding_hours: finiteOrNull(row.avg_holding_hours),
  }))
}

// Metadata is rank-bearing, so it deliberately reads the current sealed cohort
// instead of a cross-request cached payload.
async function getCurrentPublicLeaderboardMeta(platform: string, traderKey: string) {
  const cohort = await fetchPublicProfileRankingRows(getReadReplica(), {
    source: platform,
    sourceTraderId: traderKey,
    periods: ['90D'],
  })
  const row = cohort.rows[0]
  return row
    ? {
        rank: row.rank,
        arena_score: finiteOrNull(row.arena_score),
        roi: finiteOrNull(row.roi),
        pnl: finiteOrNull(row.pnl),
      }
    : null
}

// Request-deduplicated but never persistently cached: claimed ownership is an
// authorization/privacy projection. Unlink must remove owner routing on the
// next request instead of waiting for an ISR cache entry to expire.
const findUserHandleByTraderFresh = cache(
  async (source: string, traderId: string): Promise<string | null> => {
    try {
      return await findClaimedUserHandleByIdentity(getReadReplica(), { source, traderId })
    } catch {
      return null
    }
  }
)

/**
 * Pre-render top 500 trader pages at build time for faster TTFB and better SEO.
 * Non-pre-rendered handles still work at runtime (dynamicParams = true).
 */
// generateStaticParams REMOVED — its presence causes Vercel to treat
// /trader/[handle] as an ISR route with special routing that rejects
// non-ASCII percent-encoded paths (returns x-matched-path: /500).
// Without it, the route is fully dynamic and Chinese handles work.
// The route remains dynamically rendered because rank-bearing output must not
// outlive the public serving-head proof.

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

  // A missing trader gets noindex metadata and an in-place not-found view
  // (see NOT_FOUND_METADATA). Timeout/error is not "missing": generic metadata
  // is returned and the page retries client-side, so a valid trader is never
  // de-indexed during database contention.
  if (await isMissingTrader(decoded)) return NOT_FOUND_METADATA

  // Serving-only traders (arena.* read path, spec §2.4) may not exist in the
  // legacy tables; their display name comes from the serving resolver.
  const servingMeta = resolved === null ? await cachedServingResolve(decoded) : null

  const isUnavailable = resolved === RESOLVE_UNAVAILABLE
  const resolvedData = (isUnavailable ? null : resolved) as Exclude<
    ResolveResult,
    typeof RESOLVE_UNAVAILABLE
  >

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
      lr = await getCurrentPublicLeaderboardMeta(resolvedData.platform, resolvedData.traderKey)
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
    ? traderCanonicalPath({
        handle: resolvedData.handle,
        sourceTraderId: resolvedData.traderKey,
        source: resolvedData.platform,
      })
    : servingMeta
      ? // 只存在于新数据层的交易员：同样带 ?platform=，不退回裸路径。
        traderCanonicalPath({
          handle: servingMeta.nickname,
          sourceTraderId: servingMeta.exchangeTraderId,
          source: servingMeta.source,
        })
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

// A generated HTML payload can contain rank/ROI/score. Do not let ISR serve it
// after the source's public serving head has changed or been withdrawn.
export const revalidate = 0

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
    // Everything here depends only on the resolved identity, so it runs in
    // one parallel batch. Per-TF sub-scores (ScoreBreakdown/header) are
    // best-effort with a 2s cap so they can never extend the batch beyond it.
    const [firstScreenRaw, capabilities, userHandle, verifiedKeys, servingScores] =
      await Promise.all([
        getCurrentPublicFirstScreen(servingResolved.source, servingResolved.exchangeTraderId),
        cachedCapabilities(),
        findUserHandleByTraderFresh(servingResolved.source, servingResolved.exchangeTraderId),
        getVerifiedTraderKeys(getReadReplica()),
        Promise.race([
          getCurrentPublicServingScores(
            servingResolved.source,
            servingResolved.exchangeTraderId
          ).catch((e) => {
            logger.warn('[trader/page] getCurrentPublicServingScores failed', {
              source: servingResolved.source,
              error: String(e),
            })
            return []
          }),
          new Promise<never[]>((resolve) => setTimeout(() => resolve([]), 2_000)),
        ]),
      ])

    // ROOT-CAUSE FIX (2026-06-11): a serving-only trader (exists only in arena.*,
    // not in legacy trader_sources/leaderboard_ranks) MUST NEVER fall through to
    // the legacy /api/traders endpoint — that endpoint 404s for serving sources,
    // and the client then renders a full-page "Trader Not Found" even though the
    // page itself returned HTTP 200. The previous code passed
    // servingFirstScreen={null} on first-screen timeout, which flipped the client
    // back into legacy mode. Instead, synthesize a minimal first-screen from the
    // already-resolved identity so the client stays in serving mode and lets
    // ServingProfilePanel render its body on its own (the public /core projection
    // is quarantined, so the panel builds it locally with no request and shows the
    // under-verification state). entries=[] is a valid empty board, not a missing trader.
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
      headline_window: headlineWindowFor(best?.timeframe),
      is_verified_data: verifiedKeys.has(
        verifiedTraderKey(servingResolved.source, servingResolved.exchangeTraderId)
      ),
    }

    // U2-12: similar-traders module regression. The serving three-tab data path
    // (useServingTabData → /core) never carried similarTraders, so OverviewTab's
    // `traderSimilar.length > 0` guard permanently hid the module for serving
    // sources (the default). Legacy path fed it via bridge.ts; serving didn't.
    // Fix: compute it once here server-side using the 90d board score/roi, map
    // to the OverviewTab shape (same shape as bridge.ts:203), and thread it down
    // as serverSimilarTraders. NOT cached: fetchSimilarTraders queries the
    // sealed public cohort on every render (a cached slice could outlive its
    // serving proof); the query carries its own 2s abort so it stays
    // best-effort. It depends on the first-screen board entry, so it runs
    // after the parallel batch above.

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
      followers: st.followers ?? undefined,
      avatar_url: st.avatarUrl ?? undefined,
      source: st.platform,
      roi_90d: st.roi ?? undefined,
      arena_score: st.arenaScore ?? undefined,
    }))

    const servingCanonicalUrl = `${BASE_URL}${traderCanonicalPath({
      handle: servingTraderData.handle,
      sourceTraderId: servingResolved.exchangeTraderId,
      source: servingResolved.source,
    })}`
    const servingJsonLd = generateTraderProfilePageSchema({
      url: servingCanonicalUrl,
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
      // 榜单在首页；/rankings 是 308 重定向。
      { name: 'Rankings', url: `${BASE_URL}/` },
      { name: servingTraderData.handle, url: servingCanonicalUrl },
    ])

    // servingFirstScreen is now ALWAYS non-null for serving sources (synthesized
    // above on timeout), so the client stays in serving mode and never falls back
    // to the legacy 404 path. ServingProfilePanel renders the body from the static
    // quarantined core projection (no /core request) plus on-demand record tabs.
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

  // Do NOT call notFound() here: this page renders inside the loading.tsx
  // boundary, after the shell has been sent with HTTP 200, so a thrown
  // notFound() is resolved only in the browser (React error #419) and adds a
  // conflicting robots meta. Render the not-found view in place instead;
  // generateMetadata marks the same handles noindex via isMissingTrader.
  if (resolved === RESOLVE_UNAVAILABLE) return null
  if (!resolved || isRetiredSource(resolved.platform)) {
    return (await isMissingTrader(decodedHandle)) ? <TraderNotFound /> : null
  }

  // Phase 2: Fetch trader detail. The rank-bearing projection reads the current
  // public cohort; claim ownership is looked up in parallel by the resolved
  // composite identity.
  const claimedUserProfile = null

  const [detailResult, userHandle] = await Promise.all([
    getCurrentPublicTraderDetail(resolved.platform, resolved.traderKey).catch((err) => {
      // Log real fetch failures so they aren't silently masked as "no data".
      logger.error(
        '[trader/page] getCurrentPublicTraderDetail unexpected error:',
        err instanceof Error ? err.message : err
      )
      return null
    }),
    findUserHandleByTraderFresh(resolved.platform, resolved.traderKey),
  ])

  const serverTraderData = detailResult
    ? toTraderPageData(detailResult, { publicProfileHistoryQuarantine: true })
    : null

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
          // No headline_window = the header labels these 90D: 90D values only,
          // never the primary-period arena_score or a 30D/7D ROI (P1-3).
          arena_score: ((serverTraderData.performance as Record<string, unknown>).arena_score_90d ??
            null) as number | null,
          roi: ((serverTraderData.performance as Record<string, unknown>).roi_90d ?? null) as
            | number
            | null,
          pnl: (serverTraderData.performance as Record<string, unknown>).pnl as number | null,
          win_rate: (serverTraderData.performance as Record<string, unknown>).win_rate as
            | number
            | null,
          max_drawdown: (serverTraderData.performance as Record<string, unknown>).max_drawdown as
            | number
            | null,
          // toTraderPageData puts the sealed-cohort rank at the top level; the
          // performance object has no `rank` key, so reading it there left the
          // header rank badge permanently empty for these traders.
          rank: (serverTraderData.rank as number | null | undefined) ?? null,
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
  const legacyCanonicalUrl = `${BASE_URL}${traderCanonicalPath({
    handle: resolved.handle,
    sourceTraderId: resolved.traderKey,
    source: resolved.platform,
  })}`
  const traderSchemaInput: TraderSchemaInput = {
    url: legacyCanonicalUrl,
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
    { name: 'Rankings', url: `${BASE_URL}/` },
    { name: traderData.handle, url: legacyCanonicalUrl },
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
