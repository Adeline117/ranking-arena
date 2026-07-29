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
import { getVerifiedTraderKeys, verifiedTraderKey } from '@/lib/data/verified-traders'
import { createOgVerificationProof } from '@/lib/utils/og-verification-proof'
import WrappedCardClient from '@/app/(app)/wrapped/[handle]/WrappedCardClient'
import type { WrappedTraderData } from '@/app/(app)/wrapped/[handle]/page'
import { BASE_URL } from '@/lib/constants/urls'
import { platformLabel } from '@/lib/constants/platform-labels'
import { createLogger } from '@/lib/utils/logger'
import { filterPublicRankingSources } from '@/lib/rankings/publication-policy'
import { readSealedRankingAuthorityGeneration } from '@/lib/rankings/read-sealed-ranking-generation'

const logger = createLogger('share-rank')

export const revalidate = 300

// SSR timeout: during cron contention, resolveTrader can block on row locks
// for 30+ seconds. Race against this timeout so users see a fast 404 instead.
const SSR_TIMEOUT_MS = 3000

interface Props {
  params: Promise<{ trader_key: string }>
  searchParams: Promise<{ platform?: string; window?: string; ref?: string }>
}

async function resolveTraderForWrapped(
  traderKey: string,
  platform?: string,
  windowParam = '7d'
): Promise<{ handle: string | null; data: WrappedTraderData | null }> {
  try {
    const supabase = getSupabaseAdmin()
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
      resolveTraderUnified(supabase, { handle: traderKey, platform }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_TIMEOUT_MS)),
    ])

    if (!resolved) return { handle: null, data: null }
    const [publicPlatform] = filterPublicRankingSources([resolved.platform])
    if (!publicPlatform) return { handle: null, data: null }

    const effectivePlatform = publicPlatform
    const platLabel = platformLabel(publicPlatform)

    const sealedRead = await Promise.race([
      readSealedRankingAuthorityGeneration(
        supabase,
        seasonId as '7D' | '30D' | '90D',
        async (publication) => {
          const rankResult = await supabase
            .from('leaderboard_ranks')
            .select('rank, rank_change, roi, win_rate, arena_score, max_drawdown, season_id')
            .eq('source', publicPlatform)
            .eq('source_trader_id', resolved.traderKey)
            .eq('season_id', seasonId)
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .maybeSingle()
          if (rankResult.error) {
            throw new Error(`share rank query failed: ${rankResult.error.message}`)
          }
          return {
            rank: rankResult.data,
            total: publication.proofs.reduce((sum, proof) => sum + proof.published_rank_count, 0),
          }
        },
        { timeoutMs: SSR_TIMEOUT_MS }
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), SSR_TIMEOUT_MS)),
    ])
    if (!sealedRead) return { handle: null, data: null }
    const lr = sealedRead.value.rank

    const verifiedKeys = await getVerifiedTraderKeys(supabase)
    const isVerifiedData = verifiedKeys.has(
      verifiedTraderKey(resolved.platform, resolved.traderKey)
    )
    const data: WrappedTraderData = {
      handle: resolved.handle || traderKey,
      displayName: resolved.handle || traderKey,
      platform: effectivePlatform,
      platformLabel: platLabel,
      rank: lr?.rank ?? null,
      rankChange: lr?.rank_change ?? null,
      isVerifiedData,
      verifiedDataProof: isVerifiedData
        ? await createOgVerificationProof(resolved.platform, resolved.traderKey)
        : null,
      verificationSource: resolved.platform,
      verificationTraderId: resolved.traderKey,
      total: sealedRead.value.total,
      roi: lr?.roi ?? null,
      winRate: lr?.win_rate ?? null,
      score: lr?.arena_score ?? null,
      maxDrawdown: lr?.max_drawdown ?? null,
      window: seasonId,
    }

    return { handle: resolved.handle || null, data }
  } catch (error) {
    logger.warn(
      '[share/rank] resolve failed:',
      error instanceof Error ? error.message : String(error)
    )
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
  // `rank`/`Top X%` are GLOBAL cross-source-board positions, so frame them as such —
  // not "on {platform}" (which falsely implied a per-platform ranking).
  const description = parts.length
    ? `${parts.join(' | ')} across Arena's current public source boards`
    : `${name}'s trading performance card on Arena`

  const ogParams = new URLSearchParams({
    name,
    handle: data?.handle ?? decoded,
    platform: data?.platform ?? platform ?? '',
    window: data?.window ?? windowParam,
  })
  if (rank != null) ogParams.set('rank', String(rank))
  if (data?.rankChange != null) ogParams.set('rankChange', String(data.rankChange))
  if (data?.verifiedDataProof) {
    ogParams.set('verification', data.verifiedDataProof)
    ogParams.set('verificationSource', data.verificationSource)
    ogParams.set('verificationTrader', data.verificationTraderId)
  }
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
  const { platform, window: windowParam = '7d', ref } = await searchParams
  const decoded = decodeURIComponent(trader_key)

  const { handle, data } = await resolveTraderForWrapped(decoded, platform, windowParam)

  // If we found a handle, redirect to the canonical /wrapped/ URL
  if (handle) {
    const redirectParams = new URLSearchParams()
    if (platform) redirectParams.set('platform', platform)
    if (windowParam !== '7d') redirectParams.set('window', windowParam)
    // Preserve the sharer's referral code through the redirect so the root
    // layout's pre-hydration `?ref` capture runs on the /wrapped page and the
    // referral attribution survives the brag → click → landing loop.
    if (ref && /^[A-Za-z0-9_-]{2,64}$/.test(ref)) redirectParams.set('ref', ref)
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
  if (data.rankChange != null) ogParams.set('rankChange', String(data.rankChange))
  if (data.verifiedDataProof) {
    ogParams.set('verification', data.verifiedDataProof)
    ogParams.set('verificationSource', data.verificationSource)
    ogParams.set('verificationTrader', data.verificationTraderId)
  }
  if (data.total != null) ogParams.set('total', String(data.total))
  if (data.roi != null) ogParams.set('roi', String(data.roi))
  if (data.winRate != null) ogParams.set('winRate', String(data.winRate))
  if (data.score != null) ogParams.set('score', String(data.score))

  const ogImageUrl = `/api/og/rank?${ogParams}`

  return <WrappedCardClient data={data} ogImageUrl={ogImageUrl} />
}
