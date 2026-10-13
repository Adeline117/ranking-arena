import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveTrader } from '@/lib/data/unified'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'
import {
  buildCompareUrl,
  parseCompareAccounts,
  type CompareAccountRef,
} from '@/lib/compare/identity'

const PUBLIC_COMPARE_RANKING_COLUMNS =
  'handle,source,source_trader_id,season_id,rank,roi,arena_score,pnl,win_rate,max_drawdown,score_completeness,metrics_estimated,is_outlier,computed_at'

type PublicCompareRankingQueryResult = {
  data: unknown | null
  error: { message: string } | null
}

type PublicCompareRankingQuery = {
  select(columns: string): PublicCompareRankingQuery
  eq(column: string, value: string): PublicCompareRankingQuery
  maybeSingle(): Promise<PublicCompareRankingQueryResult>
}

type PublicCompareRankingClient = {
  from(relation: 'public_ranked_leaderboard'): PublicCompareRankingQuery
}

type VerifiedCompareRanking = {
  handle: string
  source: string
  roi: number
  arenaScore: number
  pnl: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrow bridge while generated Supabase types catch up with the public view. */
function publicCompareRankingClient(value: unknown): PublicCompareRankingClient {
  if (!isRecord(value) || typeof value.from !== 'function') {
    throw new TypeError('Supabase client does not expose the public ranking cohort')
  }
  return value as PublicCompareRankingClient
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function positiveRank(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

/**
 * The security-barrier view is the cohort authority. Re-check every row at
 * this server boundary as well: a stale cache/proxy payload must never turn
 * into a public OG score or return claim.
 */
function verifyCompareRanking(
  candidate: unknown,
  source: string,
  sourceTraderId: string
): VerifiedCompareRanking | null {
  const sanitized = sanitizePublicRankingPayload(
    { traders: candidate === null ? [] : [candidate], period: '90D' },
    { expectedPeriod: '90D' }
  ) as { traders?: unknown[] }
  const row = sanitized.traders?.[0]
  if (
    !isRecord(row) ||
    row.source !== source ||
    row.source_trader_id !== sourceTraderId ||
    !positiveRank(row.rank) ||
    !finiteNumber(row.roi) ||
    !finiteNumber(row.arena_score) ||
    !finiteNumber(row.pnl)
  ) {
    return null
  }

  const handle =
    typeof row.handle === 'string' && row.handle.trim().length > 0
      ? row.handle.trim()
      : sourceTraderId
  return {
    // The OG route uses comma-separated transport. Preserve the identity but
    // prevent an exchange handle containing a comma from changing card count.
    handle: handle.replaceAll(',', ' '),
    source,
    roi: row.roi,
    arenaScore: row.arena_score,
    pnl: row.pnl,
  }
}

/**
 * The og/compare route renders from name/roi/score query params (edge, no DB).
 * Previously this layout passed only `ids`, which og/compare ignores → every
 * shared /compare link unfurled a FAKE "Trader A · SCORE -- · ROI +0.0%" card.
 * We resolve the ids here (server, service-role) into real names/rois/scores and
 * pass those only after the sealed public ranking cohort and a local proof
 * sanitizer agree. On any failure we fall back to the static site image rather
 * than a fabricated card. (`/api/compare` can't be used — it's auth-gated,
 * crawlers 401.)
 */
async function buildCompareOgUrl(accounts: CompareAccountRef[]): Promise<string> {
  const staticFallback = `${BASE_URL}/og-image.png`
  if (accounts.length === 0) return staticFallback
  try {
    const supabase = getSupabaseAdmin()
    const rows = await Promise.all(
      accounts.map(async (account) => {
        const resolved = await resolveTrader(supabase, {
          handle: account.id,
          platform: account.source,
        })
        if (!resolved) return null
        const { data, error } = await publicCompareRankingClient(supabase)
          .from('public_ranked_leaderboard')
          .select(PUBLIC_COMPARE_RANKING_COLUMNS)
          .eq('source', resolved.platform)
          .eq('source_trader_id', resolved.traderKey)
          .eq('season_id', '90D')
          .maybeSingle()
        if (error) return null
        return verifyCompareRanking(data, resolved.platform, resolved.traderKey)
      })
    )
    // A partial card would silently change the comparison selected in the
    // shared URL. Without a verified row for every account, publish no rank-
    // derived metric at all.
    if (rows.some((row) => row === null)) return staticFallback

    const verifiedRows = rows as VerifiedCompareRanking[]
    const names = verifiedRows.map((row) => row.handle).join(',')
    const platforms = verifiedRows.map((row) => row.source).join(',')
    const rois = verifiedRows.map((row) => Math.round(row.roi * 10) / 10).join(',')
    const scores = verifiedRows.map((row) => Math.round(row.arenaScore)).join(',')
    const pnls = verifiedRows.map((row) => Math.round(row.pnl)).join(',')
    return (
      `${BASE_URL}/api/og/compare?names=${encodeURIComponent(names)}` +
      `&platforms=${encodeURIComponent(platforms)}&rois=${rois}&scores=${scores}&pnls=${pnls}`
    )
  } catch {
    return staticFallback
  }
}

export async function generateMetadata(props: {
  searchParams?: Promise<{ ids?: string; platforms?: string }>
}): Promise<Metadata> {
  const resolved = props.searchParams ? await props.searchParams : {}
  const ids = resolved.ids
  const platforms = resolved.platforms
  const parsed = parseCompareAccounts(ids, platforms)
  const accounts = parsed.ok ? parsed.accounts : []

  const ogUrl = await buildCompareOgUrl(accounts.slice(0, 3))

  const title = 'Compare Traders'
  const description =
    accounts.length > 0
      ? `Comparing ${accounts.length} traders side-by-side on Arena`
      : 'Compare traders side-by-side across exchanges.'

  return {
    title,
    description,
    alternates: {
      canonical: `${BASE_URL}/compare`,
    },
    openGraph: {
      title,
      description,
      url: `${BASE_URL}${buildCompareUrl(accounts)}`,
      siteName: 'Arena',
      type: 'website',
      images: [{ url: ogUrl, width: 1200, height: 630, alt: 'Arena Trader Comparison' }],
    },
    twitter: {
      card: 'summary_large_image',
      title,
      description,
      images: [ogUrl],
      creator: '@arenafi',
    },
  }
}

export default function CompareLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}
