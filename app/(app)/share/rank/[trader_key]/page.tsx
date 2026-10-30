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
import {
  isPublicRankingSourceAllowed,
  sanitizePublicRankingPayload,
} from '@/lib/rankings/publication-policy'
import WrappedCardClient from '@/app/(app)/wrapped/[handle]/WrappedCardClient'
import type { WrappedTraderData } from '@/app/(app)/wrapped/[handle]/page'
import { BASE_URL } from '@/lib/constants/urls'
import { platformLabel } from '@/lib/constants/platform-labels'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('share-rank')

export const revalidate = 300

// A sealed row membership proof is available through this view, while a
// global count receipt scoped to the same seal is not. Keep that distinction
// explicit: share cards may show a verified rank but must leave total and
// percentile unknown instead of reading raw MAX(rank) or a count cache.
const PUBLIC_SHARE_RANK_COLUMNS =
  'rank,rank_change,roi,pnl,win_rate,arena_score,max_drawdown,source,source_trader_id,score_completeness,metrics_estimated,is_outlier,computed_at,season_id'

type PublicShareRankQueryResult = {
  data: unknown | null
  error: { message: string } | null
}

type PublicShareRankQuery = {
  select(columns: string): PublicShareRankQuery
  eq(column: string, value: string): PublicShareRankQuery
  maybeSingle(): Promise<PublicShareRankQueryResult>
}

type PublicShareRankClient = {
  from(relation: 'public_ranked_leaderboard'): PublicShareRankQuery
}

type VerifiedShareRank = {
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
function publicShareRankClient(value: unknown): PublicShareRankClient {
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicShareRankClient
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function positiveRankOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

function verifiedShareRank(
  candidate: unknown,
  source: string,
  sourceTraderId: string,
  seasonId: string
): VerifiedShareRank | null {
  // A public view row is still rechecked locally so a stale cache/proxy or a
  // malformed row cannot become a public rank, metric, or OG-card claim.
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

// SSR timeout: during cron contention, resolveTrader can block on row locks
// for 30+ seconds. Race against this timeout so users see a fast 404 instead.
const SSR_TIMEOUT_MS = 3000

interface Props {
  params: Promise<{ trader_key: string }>
  searchParams: Promise<{ platform?: string; window?: string }>
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

    const effectivePlatform = platform || resolved.platform
    const platLabel = platformLabel(effectivePlatform)

    const rankResult = isPublicRankingSourceAllowed(resolved.platform)
      ? await Promise.race([
          publicShareRankClient(supabase)
            .from('public_ranked_leaderboard')
            .select(PUBLIC_SHARE_RANK_COLUMNS)
            .eq('source', resolved.platform)
            .eq('source_trader_id', resolved.traderKey)
            .eq('season_id', seasonId)
            .maybeSingle(),
          new Promise<PublicShareRankQueryResult>((resolve) =>
            setTimeout(() => resolve({ data: null, error: null }), SSR_TIMEOUT_MS)
          ),
        ])
      : { data: null, error: null }
    if (rankResult.error) {
      logger.warn('[share/rank] public ranking lookup failed:', {
        source: resolved.platform,
        traderKey: resolved.traderKey,
        seasonId,
        error: rankResult.error.message,
      })
    }
    const rankData = rankResult.error
      ? null
      : verifiedShareRank(rankResult.data, resolved.platform, resolved.traderKey, seasonId)

    const verifiedKeys = await getVerifiedTraderKeys(supabase)
    const isVerifiedData = verifiedKeys.has(
      verifiedTraderKey(resolved.platform, resolved.traderKey)
    )
    const data: WrappedTraderData = {
      handle: resolved.handle || traderKey,
      displayName: resolved.handle || traderKey,
      platform: effectivePlatform,
      platformLabel: platLabel,
      rank: rankData?.rank ?? null,
      rankChange: rankData?.rankChange ?? null,
      isVerifiedData,
      verifiedDataProof: isVerifiedData
        ? await createOgVerificationProof(resolved.platform, resolved.traderKey)
        : null,
      verificationSource: resolved.platform,
      verificationTraderId: resolved.traderKey,
      // No same-seal count authority is available on this path. Do not
      // construct a denominator from raw ranks or a cache.
      total: null,
      roi: rankData?.roi ?? null,
      winRate: rankData?.winRate ?? null,
      score: rankData?.score ?? null,
      maxDrawdown: rankData?.maxDrawdown ?? null,
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
  // `rank`/`Top X%` are GLOBAL cross-exchange positions, so frame them as such —
  // not "on {platform}" (which falsely implied a per-exchange ranking).
  const description = parts.length
    ? `${parts.join(' | ')} across all tracked exchanges on Arena`
    : `${name}'s trading performance card on Arena`

  const ogParams = new URLSearchParams({
    name,
    handle: data?.handle ?? decoded,
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
