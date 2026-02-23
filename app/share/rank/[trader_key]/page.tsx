/**
 * /share/rank/[trader_key] — shareable rank card by source_trader_id
 *
 * This route is designed for the "Share on X" button on trader profiles.
 * It accepts trader_key (source_trader_id) instead of handle, so the URL
 * works regardless of whether the trader has a readable handle.
 *
 * X/Twitter scrapes this page's OG meta tags and displays the rank card image.
 * The page body shows WrappedCardClient for humans who follow the link.
 */

import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import WrappedCardClient from '@/app/wrapped/[handle]/WrappedCardClient'
import type { WrappedTraderData } from '@/app/wrapped/[handle]/page'

const BASE_URL = process.env.NEXT_PUBLIC_APP_URL || process.env.NEXT_PUBLIC_SITE_URL || 'https://www.arenafi.org'

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

async function fetchShareData(
  traderKey: string,
  platform?: string,
  windowParam = '7d',
): Promise<WrappedTraderData | null> {
  try {
    const supabase = getSupabaseAdmin()
    const seasonMap: Record<string, string> = {
      '7d': '7D', '30d': '30D', '90d': '90D',
      '7D': '7D', '30D': '30D', '90D': '90D',
    }
    const seasonId = seasonMap[windowParam] ?? '7D'

    // Look up by source_trader_id first, then fall back to handle
    let tsQuery = supabase
      .from('trader_sources')
      .select('handle, display_name, source, source_trader_id')
      .eq('source_trader_id', traderKey)
      .limit(1)

    if (platform) tsQuery = tsQuery.eq('source', platform)
    let { data: ts } = await tsQuery.maybeSingle()

    // Fallback: try matching handle
    if (!ts) {
      let hQuery = supabase
        .from('trader_sources')
        .select('handle, display_name, source, source_trader_id')
        .ilike('handle', traderKey)
        .limit(1)
      if (platform) hQuery = hQuery.eq('source', platform)
      const { data: byHandle } = await hQuery.maybeSingle()
      ts = byHandle
    }

    if (!ts) return null

    const effectivePlatform = platform || ts.source
    const platformLabel = PLATFORM_LABELS[effectivePlatform]
      ?? effectivePlatform.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase())

    const { data: lr } = await supabase
      .from('leaderboard_ranks')
      .select('rank, roi, win_rate, arena_score, max_drawdown, season_id')
      .eq('source', ts.source)
      .eq('source_trader_id', ts.source_trader_id)
      .eq('season_id', seasonId)
      .maybeSingle()

    const { count } = await supabase
      .from('leaderboard_ranks')
      .select('*', { count: 'exact', head: true })
      .eq('source', ts.source)
      .eq('season_id', seasonId)

    return {
      handle: ts.handle || traderKey,
      displayName: ts.display_name || ts.handle || traderKey,
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
  } catch {
    return null
  }
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { trader_key } = await params
  const { platform, window: windowParam = '7d' } = await searchParams
  const decoded = decodeURIComponent(trader_key)

  const data = await fetchShareData(decoded, platform, windowParam)

  const name = data?.displayName || decoded
  const rank = data?.rank
  const roi = data?.roi
  const topPct = rank && data?.total ? Math.ceil((rank / data.total) * 100) : null

  const roiStr = roi != null ? `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% ROI` : null
  const rankStr = rank != null ? `Ranked #${rank}` : null
  const topStr = topPct != null && topPct <= 25 ? `Top ${topPct}% trader` : null
  const parts = [rankStr, roiStr, topStr].filter(Boolean)

  const title = `${name} — Arena Rank Card`
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
  const pageUrl = `${BASE_URL}/share/rank/${encodeURIComponent(decoded)}${platform ? `?platform=${platform}` : ''}`

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

  const data = await fetchShareData(decoded, platform, windowParam)
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
