/**
 * /wrapped/[handle] — Spotify Wrapped–style trader rank card
 *
 * Server component: fetches rank data, sets OG meta tags with
 * the dynamic OG image so X/Twitter shows the card preview.
 * Then renders the interactive client card with download + share buttons.
 */

import type { Metadata } from 'next'
import { cache } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveTrader } from '@/lib/data/unified'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { createOgVerificationProof } from '@/lib/utils/og-verification-proof'
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import WrappedCardClient from './WrappedCardClient'
import WrappedEmptyState from './WrappedEmptyState'
import WrappedUnavailableState from './WrappedUnavailableState'
import { BASE_URL } from '@/lib/constants/urls'

// This route only reads public ranking data. Its searchParams prop keeps each
// platform/window variant request-rendered; leave the segment on Next's
// default "auto" policy and use request-scoped React cache below for dedupe.

// Platform display label map
const PLATFORM_LABELS: Record<string, string> = {
  binance_futures: 'Binance',
  binance_spot: 'Binance Spot',
  binance_web3: 'Binance Web3',
  bybit: 'Bybit',
  bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget',
  bitget_spot: 'Bitget Spot',
  okx: 'OKX',
  okx_spot: 'OKX Spot',
  okx_web3: 'OKX Web3',
  okx_futures: 'OKX',
  hyperliquid: 'Hyperliquid',
  gmx: 'GMX',
  dydx: 'dYdX',
  mexc: 'MEXC',
  kucoin: 'KuCoin',
  gateio: 'Gate.io',
  htx_futures: 'HTX',
  weex: 'Weex',
  blofin: 'Blofin',
  coinex: 'CoinEx',
}

// This browser-facing card has no count receipt scoped to the same sealed
// cohort as its rank. Keep the row proof and the count authority separate:
// `public_ranked_leaderboard` proves whether a row may be ranked, but it does
// not expose a verifiable global denominator. Consequently this page never
// derives one from an unsealed maximum rank or a cache.
const PUBLIC_WRAPPED_RANK_COLUMNS =
  'rank,rank_change,roi,pnl,win_rate,arena_score,max_drawdown,source,source_trader_id,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

type VerifiedWrappedRank = {
  rank: number
  rankChange: number | null
  roi: number | null
  winRate: number | null
  score: number | null
  maxDrawdown: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Local bridge until generated Supabase types include the additive public view. */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveRankOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function verifiedWrappedRank(
  candidate: unknown,
  source: string,
  sourceTraderId: string,
  seasonId: string
): VerifiedWrappedRank | null {
  // The view is the database authority, and this local check is the cache/
  // proxy defense in depth. A malformed, stale, partial, estimated, or
  // wrong-period row must become unknown instead of a shareable claim.
  const sanitized = sanitizePublicRankingPayload(
    { traders: candidate === null ? [] : [candidate], period: seasonId },
    { expectedPeriod: seasonId }
  ) as { traders?: unknown[] }
  const row = sanitized.traders?.[0]
  if (!isRecord(row) || row.source !== source || row.source_trader_id !== sourceTraderId) {
    return null
  }

  const rank = positiveRankOrNull(row.rank)
  if (rank === null) return null

  return {
    rank,
    rankChange: finiteOrNull(row.rank_change),
    roi: finiteOrNull(row.roi),
    winRate: finiteOrNull(row.win_rate),
    score: finiteOrNull(row.arena_score),
    maxDrawdown: finiteOrNull(row.max_drawdown),
  }
}

/** @deprecated UI-specific. Will be replaced by UnifiedTrader adapter. */
export interface WrappedTraderData {
  handle: string
  displayName: string
  platform: string
  platformLabel: string
  rank: number | null
  /** Movement vs the previous ranking computation (+ = climbed). */
  rankChange: number | null
  /** Active read-only exchange authorization; source of the ✓ Verified data mark. */
  isVerifiedData: boolean
  /** Short-lived HMAC proof; only consumed by the public OG image route. */
  verifiedDataProof: string | null
  verificationSource: string
  verificationTraderId: string
  /** Unknown: this route has no same-cohort global denominator authority. */
  total: number | null
  roi: number | null
  winRate: number | null
  score: number | null
  maxDrawdown: number | null
  window: string
}

interface Props {
  params: Promise<{ handle: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
}

// SSR timeout: during cron contention, resolveTrader can block on row locks
// for 30+ seconds. Race against this timeout so users get a fast, retryable
// unavailable state (NOT a 404 — the trader may well exist).
const SSR_TIMEOUT_MS = 3000

// Discriminated result so the page can tell "no matching snapshot" (→ empty
// state) apart from transient timeouts / DB errors (→ retryable unavailable
// state). Collapsing them was serving a false missing/fatal state for traders
// that exist whenever the DB was slow.
type WrappedFetchResult =
  | { ok: true; data: WrappedTraderData }
  | { ok: false; reason: 'not_found' | 'timeout' | 'error' }

const RESOLVE_TIMEOUT = Symbol('resolve-timeout')

async function fetchWrappedDataUncached(
  handle: string,
  platform?: string,
  windowParam = '7d'
): Promise<WrappedFetchResult> {
  try {
    const supabase = getSupabaseAdmin()

    // Map UI window param to season_id used in the DB
    const seasonMap: Record<string, string> = {
      '7d': '7D',
      '30d': '30D',
      '90d': '90D',
      '7D': '7D',
      '30D': '30D',
      '90D': '90D',
    }
    const seasonId = seasonMap[windowParam] ?? '7D'

    // Use unified resolveTrader with timeout — this is the call that hangs
    // during compute-leaderboard cron contention
    const resolved = await Promise.race([
      resolveTrader(supabase, { handle, platform }),
      new Promise<typeof RESOLVE_TIMEOUT>((resolve) =>
        setTimeout(() => resolve(RESOLVE_TIMEOUT), SSR_TIMEOUT_MS)
      ),
    ])

    if (resolved === RESOLVE_TIMEOUT) {
      console.error(
        `[wrapped] resolveTrader timed out after ${SSR_TIMEOUT_MS}ms (handle=${handle}, platform=${platform ?? '-'}) — transient, not a 404`
      )
      return { ok: false, reason: 'timeout' }
    }
    if (!resolved) return { ok: false, reason: 'not_found' }

    const effectivePlatform = platform || resolved.platform
    const platformLabel =
      PLATFORM_LABELS[effectivePlatform] ??
      effectivePlatform.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

    const rankResult = isPublicRankingSourceAllowed(resolved.platform)
      ? await Promise.race([
          supabase
            .from('public_ranked_leaderboard')
            .select(PUBLIC_WRAPPED_RANK_COLUMNS)
            .eq('source', resolved.platform)
            .eq('source_trader_id', resolved.traderKey)
            .eq('season_id', seasonId)
            .maybeSingle(),
          new Promise<{ data: null; error: null }>((resolve) =>
            setTimeout(() => resolve({ data: null, error: null }), SSR_TIMEOUT_MS)
          ),
        ])
      : { data: null, error: null }
    if (rankResult.error) {
      console.error(
        `[wrapped] public_ranked_leaderboard lookup failed (source=${resolved.platform}, trader=${resolved.traderKey}, season=${seasonId}):`,
        rankResult.error.message
      )
    }
    const rankData = rankResult.error
      ? null
      : verifiedWrappedRank(rankResult.data, resolved.platform, resolved.traderKey, seasonId)

    // No same-seal global denominator is published to this route. Never infer
    // it from an unsealed maximum rank or a count cache.
    const total = null
    const verifiedKeys = await getVerifiedTraderKeys(supabase)
    const isVerifiedData = verifiedKeys.has(
      verifiedTraderKey(resolved.platform, resolved.traderKey)
    )
    const verifiedDataProof = isVerifiedData
      ? await createOgVerificationProof(resolved.platform, resolved.traderKey)
      : null

    return {
      ok: true,
      data: {
        handle: resolved.handle || handle,
        displayName: resolved.handle || handle,
        platform: effectivePlatform,
        platformLabel,
        rank: rankData?.rank ?? null,
        rankChange: rankData?.rankChange ?? null,
        isVerifiedData,
        verifiedDataProof,
        verificationSource: resolved.platform,
        verificationTraderId: resolved.traderKey,
        total,
        roi: rankData?.roi ?? null,
        winRate: rankData?.winRate ?? null,
        score: rankData?.score ?? null,
        maxDrawdown: rankData?.maxDrawdown ?? null,
        window: seasonId,
      },
    }
  } catch (error) {
    // NEVER swallow DB errors silently (CLAUDE.md hard rule) — and a DB
    // error is transient, not proof the handle does not exist.
    console.error(
      `[wrapped] fetchWrappedData failed (handle=${handle}, platform=${platform ?? '-'}):`,
      error
    )
    return { ok: false, reason: 'error' }
  }
}

// generateMetadata and the page render both need the same public snapshot.
// React cache is scoped to one server request, so this dedupes that work
// without persisting transient timeout/error results across users or requests.
const fetchWrappedData = cache(fetchWrappedDataUncached)

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { handle } = await params
  const { platform, window: windowParam = '7d' } = await searchParams
  const decoded = decodeURIComponent(handle)

  const result = await fetchWrappedData(decoded, platform, windowParam)
  const data = result.ok ? result.data : null

  const name = data?.displayName || decoded
  const rank = positiveRankOrNull(data?.rank)
  const total = positiveRankOrNull(data?.total)
  const roi = finiteOrNull(data?.roi)
  const winRate = finiteOrNull(data?.winRate)
  const score = finiteOrNull(data?.score)
  const rankChange = finiteOrNull(data?.rankChange)
  const topPct =
    rank !== null && total !== null && rank <= total ? Math.ceil((rank / total) * 100) : null

  const roiStr = roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null
  const rankStr = rank != null ? `Ranked ${rank}` : null
  const topStr = topPct != null && topPct <= 25 ? `Top ${topPct}% trader` : null

  const parts = [rankStr, roiStr, topStr].filter(Boolean)
  const title = `${name} Rank Card`
  // A verified rank is GLOBAL across the sealed cohort, so "on Binance" would
  // falsely imply a per-exchange ranking (mirrors share/rank/[trader_key]).
  const description = parts.length
    ? `${parts.join(' | ')} across all tracked exchanges on Arena`
    : `${name}'s trading performance card on Arena`

  // Build OG image URL — pass all params so the image can render without DB access
  const ogParams = new URLSearchParams({
    name,
    handle: decoded,
    platform: data?.platform ?? platform ?? '',
    window: data?.window ?? windowParam,
  })
  if (rank != null) ogParams.set('rank', String(rank))
  if (rankChange != null) ogParams.set('rankChange', String(rankChange))
  if (data?.verifiedDataProof) {
    ogParams.set('verification', data.verifiedDataProof)
    ogParams.set('verificationSource', data.verificationSource)
    ogParams.set('verificationTrader', data.verificationTraderId)
  }
  if (total != null) ogParams.set('total', String(total))
  if (roi != null) ogParams.set('roi', String(roi))
  if (winRate != null) ogParams.set('winRate', String(winRate))
  if (score != null) ogParams.set('score', String(score))

  const ogImageUrl = `${BASE_URL}/api/og/rank?${ogParams}`
  const pageUrl = `${BASE_URL}/wrapped/${encodeURIComponent(decoded)}${platform ? `?platform=${platform}` : ''}`

  return {
    title,
    description,
    openGraph: {
      title,
      description,
      url: pageUrl,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: ogImageUrl, width: 1200, height: 630, alt: `${name} Arena Rank Card` }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogImageUrl],
      site: '@arenafi_org',
    },
    alternates: { canonical: pageUrl },
  }
}

export default async function WrappedPage({ params, searchParams }: Props) {
  const { handle } = await params
  const { platform, window: windowParam = '7d' } = await searchParams
  const decoded = decodeURIComponent(handle)

  const result = await fetchWrappedData(decoded, platform, windowParam)
  if (!result.ok) {
    // A missing snapshot is NOT a site-level 404 — the account may be valid
    // (e.g. a logged-in user viewing their own handle) but simply has no
    // ranking data yet. Render a dedicated "no rank card yet" empty state
    // instead of the generic 404 dead-end. Transient timeouts / DB errors
    // render an explicit retryable state without replacing the entire route
    // with its fatal error boundary.
    if (result.reason === 'not_found') return <WrappedEmptyState handle={decoded} />
    return <WrappedUnavailableState handle={decoded} reason={result.reason} />
  }
  const data = result.data

  // Build the OG image URL to pass to the client for download
  const ogParams = new URLSearchParams({
    name: data.displayName,
    handle: decoded,
    platform: data.platform,
    window: data.window,
  })
  const rank = positiveRankOrNull(data.rank)
  const total = positiveRankOrNull(data.total)
  const roi = finiteOrNull(data.roi)
  const winRate = finiteOrNull(data.winRate)
  const score = finiteOrNull(data.score)
  const rankChange = finiteOrNull(data.rankChange)
  if (rank != null) ogParams.set('rank', String(rank))
  if (rankChange != null) ogParams.set('rankChange', String(rankChange))
  if (data.verifiedDataProof) {
    ogParams.set('verification', data.verifiedDataProof)
    ogParams.set('verificationSource', data.verificationSource)
    ogParams.set('verificationTrader', data.verificationTraderId)
  }
  if (total != null) ogParams.set('total', String(total))
  if (roi != null) ogParams.set('roi', String(roi))
  if (winRate != null) ogParams.set('winRate', String(winRate))
  if (score != null) ogParams.set('score', String(score))

  const ogImageUrl = `/api/og/rank?${ogParams}`

  return <WrappedCardClient data={data} ogImageUrl={ogImageUrl} />
}
