/**
 * /share/rank/[trader_key] -- redirect to /wrapped/[handle]
 *
 * Legacy share URL. Looks up trader_key -> handle mapping and redirects.
 * If handle can't be resolved, renders the wrapped card in place as fallback.
 *
 * Bot crawlers (X/Twitter) see the OG meta tags in generateMetadata before
 * the redirect happens, so social cards still work even during redirect.
 */

import type { Metadata } from 'next'
import { redirect, notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveTrader as resolveTraderUnified } from '@/lib/data/unified'
import WrappedCardClient from '@/app/(app)/wrapped/[handle]/WrappedCardClient'
import type { WrappedTraderData } from '@/app/(app)/wrapped/[handle]/page'
import { BASE_URL } from '@/lib/constants/urls'

export const revalidate = 300

const PLATFORM_LABELS: Record<string, string> = {
  binance_futures: 'Binance', binance_spot: 'Binance Spot', binance_web3: 'Binance Web3',
  bybit: 'Bybit', bybit_spot: 'Bybit Spot',
  bitget_futures: 'Bitget', bitget_spot: 'Bitget Spot',
  okx: 'OKX', okx_spot: 'OKX Spot', okx_web3: 'OKX Web3', okx_futures: 'OKX',
  hyperliquid: 'Hyperliquid', gmx: 'GMX', dydx: 'dYdX',
  mexc: 'MEXC', kucoin: 'KuCoin', gateio: 'Gate.io',
  htx_futures: 'HTX', weex: 'Weex', blofin: 'Blofin', coinex: 'CoinEx',
}

interface Props {
  params: Promise<{ trader_key: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
}

async function resolveTraderForWrapped(
  traderKey: string,
  platform?: string,
  windowParam = '7d',
): Promise<{ handle: string | null; data: WrappedTraderData | null }> {
  try {
    const supabase = getSupabaseAdmin()
    const seasonMap: Record<string, string> = {
      '7d': '7D', '30d': '30D', '90d': '90D',
      '7D': '7D', '30D': '30D', '90D': '90D',
    }
    const seasonId = seasonMap[windowParam] ?? '7D'

    // Use unified resolveTrader instead of direct trader_sources queries
    const resolved = await resolveTraderUnified(supabase, { handle: traderKey, platform })

    if (!resolved) return { handle: null, data: null }

    const effectivePlatform = platform || resolved.platform
    const platformLabel = PLATFORM_LABELS[effectivePlatform]
      ?? effectivePlatform.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

    const { data: lr } = await supabase
      .from('leaderboard_ranks')
      .select('rank, roi, win_rate, arena_score, max_drawdown, season_id')
      .eq('source', resolved.platform)
      .eq('source_trader_id', resolved.traderKey)
      .eq('season_id', seasonId)
      .maybeSingle()

    const { count } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', resolved.platform)
      .eq('season_id', seasonId)

    const data: WrappedTraderData = {
      handle: resolved.handle || traderKey,
      displayName: resolved.handle || traderKey,
      platform: effectivePlatform,
      platformLabel,
      rank: lr?.rank ?? null,
      total: count ?? null,
      roi: lr?.roi ?? null,
      winRate: lr?.win_rate ?? null,
      score: lr?.arena_score ?? null,
      maxDrawdown: lr?.max_drawdown ?? null,
      window: seasonId,
    }

    return { handle: resolved.handle || null, data }
  } catch (error) {
    console.warn('[share/rank] resolve failed:', error instanceof Error ? error.message : String(error))
    return { handle: null, data: null }
  }
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { trader_key } = await params
  if (trader_key.length > 300) return { title: 'Not Found' }
  const { platform, window: windowParam = '7d' } = await searchParams
  const decoded = decodeURIComponent(trader_key)

  const { data } = await resolveTraderForWrapped(decoded, platform, windowParam)

  const name = data?.displayName || decoded
  const rank = data?.rank
  const roi = data?.roi
  const topPct = rank && data?.total ? Math.ceil((rank / data.total) * 100) : null

  const roiStr = roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null
  const rankStr = rank != null ? `Ranked ${rank}` : null
  const topStr = topPct != null && topPct <= 25 ? `Top ${topPct}% trader` : null
  const parts = [rankStr, roiStr, topStr].filter(Boolean)

  const title = `${name} Rank Card`
  const description = parts.length
    ? `${parts.join(' | ')} on ${data?.platformLabel ?? 'Arena'}`
    : `${name}'s trading performance card on Arena`

  const ogParams = new URLSearchParams({
    name,
    handle: data?.handle ?? decoded,
    platform: data?.platform ?? platform ?? '',
    window: data?.window ?? windowParam,
  })
  if (rank != null) ogParams.set('rank', String(rank))
  if (data?.total != null) ogParams.set('total', String(data.total))
  if (roi != null) ogParams.set('roi', String(roi))
  if (data?.winRate != null) ogParams.set('winRate', String(data.winRate))
  if (data?.score != null) ogParams.set('score', String(data.score))

  const ogImageUrl = `${BASE_URL}/api/og/rank?${ogParams}`
  const handle = data?.handle ?? decoded
  const pageUrl = `${BASE_URL}/wrapped/${encodeURIComponent(handle)}${platform ? '?platform=' + platform : ''}`

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

export default async function ShareRankPage({ params, searchParams }: Props) {
  const { trader_key } = await params
  const { platform, window: windowParam = '7d' } = await searchParams
  const decoded = decodeURIComponent(trader_key)

  const { handle, data } = await resolveTraderForWrapped(decoded, platform, windowParam)

  // If we found a handle, redirect to the canonical /wrapped/ URL
  if (handle) {
    const redirectParams = new URLSearchParams()
    if (platform) redirectParams.set('platform', platform)
    if (windowParam !== '7d') redirectParams.set('window', windowParam)
    const qs = redirectParams.toString()
    redirect(`/wrapped/${encodeURIComponent(handle)}${qs ? '?' + qs : ''}`)
  }

  // Fallback: render in place if no handle mapping found
  if (!data) notFound()

  const ogParams = new URLSearchParams({
    name: data.displayName,
    handle: data.handle,
    platform: data.platform,
    window: data.window,
  })
  if (data.rank != null) ogParams.set('rank', String(data.rank))
  if (data.total != null) ogParams.set('total', String(data.total))
  if (data.roi != null) ogParams.set('roi', String(data.roi))
  if (data.winRate != null) ogParams.set('winRate', String(data.winRate))
  if (data.score != null) ogParams.set('score', String(data.score))

  const ogImageUrl = `/api/og/rank?${ogParams}`

  return <WrappedCardClient data={data} ogImageUrl={ogImageUrl} />
}
