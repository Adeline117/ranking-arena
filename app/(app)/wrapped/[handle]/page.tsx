/**
 * /wrapped/[handle] — Spotify Wrapped–style trader rank card
 *
 * Server component: fetches rank data, sets OG meta tags with
 * the dynamic OG image so X/Twitter shows the card preview.
 * Then renders the interactive client card with download + share buttons.
 */

import type { Metadata } from 'next'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveTrader } from '@/lib/data/unified'
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import WrappedCardClient from './WrappedCardClient'
import WrappedEmptyState from './WrappedEmptyState'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 300

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
// error page (NOT a 404 — the trader may well exist).
const SSR_TIMEOUT_MS = 3000

// Discriminated result so the page can tell "handle genuinely does not
// exist" (→ notFound) apart from transient timeouts / DB errors (→ error
// boundary, retryable). Collapsing both into null was serving 404s for
// traders that exist whenever the DB was slow.
type WrappedFetchResult =
  | { ok: true; data: WrappedTraderData }
  | { ok: false; reason: 'not_found' | 'timeout' | 'error' }

const RESOLVE_TIMEOUT = Symbol('resolve-timeout')

async function fetchWrappedData(
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

    // Fetch leaderboard rank for this trader + window
    const { data: lr } = await Promise.race([
      supabase
        .from('leaderboard_ranks')
        .select('rank, rank_change, roi, win_rate, arena_score, max_drawdown, season_id')
        .eq('source', resolved.platform)
        .eq('source_trader_id', resolved.traderKey)
        .eq('season_id', seasonId)
        .maybeSingle(),
      new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), SSR_TIMEOUT_MS)
      ),
    ])

    // Total population for the percentile. `leaderboard_ranks.rank` is a GLOBAL
    // cross-exchange rank (ROW_NUMBER OVER ORDER BY arena_score, NO partition by
    // source), so the denominator must be the GLOBAL population, not this one
    // platform's — dividing a global rank by a per-platform count fabricated a
    // wrong "on {platform}" percentile. Use the GLOBAL MAX(rank) in the season:
    // it equals the total ranked count by construction and guarantees
    // total >= rank. The card is framed as cross-exchange accordingly.
    const { data: maxRankRow } = await Promise.race([
      supabase
        .from('leaderboard_ranks')
        .select('rank')
        .eq('season_id', seasonId)
        .order('rank', { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle(),
      new Promise<{ data: null }>((resolve) =>
        setTimeout(() => resolve({ data: null }), SSR_TIMEOUT_MS)
      ),
    ])
    const total = maxRankRow?.rank ?? null
    const verifiedKeys = await getVerifiedTraderKeys(supabase)
    const isVerifiedData = verifiedKeys.has(
      verifiedTraderKey(resolved.platform, resolved.traderKey)
    )

    return {
      ok: true,
      data: {
        handle: resolved.handle || handle,
        displayName: resolved.handle || handle,
        platform: effectivePlatform,
        platformLabel,
        rank: lr?.rank ?? null,
        rankChange: lr?.rank_change ?? null,
        isVerifiedData,
        total,
        roi: lr?.roi ?? null,
        winRate: lr?.win_rate ?? null,
        score: lr?.arena_score ?? null,
        maxDrawdown: lr?.max_drawdown ?? null,
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

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { handle } = await params
  const { platform, window: windowParam = '7d' } = await searchParams
  const decoded = decodeURIComponent(handle)

  const result = await fetchWrappedData(decoded, platform, windowParam)
  const data = result.ok ? result.data : null

  const name = data?.displayName || decoded
  const rank = data?.rank
  const roi = data?.roi
  const topPct = rank && data?.total ? Math.ceil((rank / data.total) * 100) : null

  const roiStr = roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null
  const rankStr = rank != null ? `Ranked ${rank}` : null
  const topStr = topPct != null && topPct <= 25 ? `Top ${topPct}% trader` : null

  const parts = [rankStr, roiStr, topStr].filter(Boolean)
  const title = `${name} Rank Card`
  // "across all tracked exchanges", NOT "on {platform}": leaderboard_ranks.rank is
  // a GLOBAL cross-exchange rank, so "on Binance" falsely implies a per-exchange
  // ranking (mirrors the fix already applied to share/rank/[trader_key]).
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
  if (data?.rankChange != null) ogParams.set('rankChange', String(data.rankChange))
  if (data?.isVerifiedData) ogParams.set('verified', '1')
  if (data?.total != null) ogParams.set('total', String(data.total))
  if (roi != null) ogParams.set('roi', String(roi))
  if (data?.winRate != null) ogParams.set('winRate', String(data.winRate))
  if (data?.score != null) ogParams.set('score', String(data.score))

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

export const dynamic = 'force-dynamic'

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
    // still surface the segment's error.tsx (retryable).
    if (result.reason === 'not_found') return <WrappedEmptyState handle={decoded} />
    throw new Error(`wrapped card temporarily unavailable (${result.reason}) for handle=${decoded}`)
  }
  const data = result.data

  // Build the OG image URL to pass to the client for download
  const ogParams = new URLSearchParams({
    name: data.displayName,
    handle: decoded,
    platform: data.platform,
    window: data.window,
  })
  if (data.rank != null) ogParams.set('rank', String(data.rank))
  if (data.rankChange != null) ogParams.set('rankChange', String(data.rankChange))
  if (data.isVerifiedData) ogParams.set('verified', '1')
  if (data.total != null) ogParams.set('total', String(data.total))
  if (data.roi != null) ogParams.set('roi', String(data.roi))
  if (data.winRate != null) ogParams.set('winRate', String(data.winRate))
  if (data.score != null) ogParams.set('score', String(data.score))

  const ogImageUrl = `/api/og/rank?${ogParams}`

  return <WrappedCardClient data={data} ogImageUrl={ogImageUrl} />
}
