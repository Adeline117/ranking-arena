import type { Metadata } from 'next'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { resolveTrader } from '@/lib/data/unified'

/**
 * The og/compare route renders from name/roi/score query params (edge, no DB).
 * Previously this layout passed only `ids`, which og/compare ignores → every
 * shared /compare link unfurled a FAKE "Trader A · SCORE -- · ROI +0.0%" card.
 * We resolve the ids here (server, service-role) into real names/rois/scores and
 * pass those; on any failure we fall back to the static site image rather than a
 * fabricated card. (`/api/compare` can't be used — it's auth-gated, crawlers 401.)
 */
async function buildCompareOgUrl(idList: string[]): Promise<string> {
  const staticFallback = `${BASE_URL}/og-image.png`
  if (idList.length === 0) return staticFallback
  try {
    const supabase = getSupabaseAdmin()
    const rows = (
      await Promise.all(
        idList.map(async (id) => {
          const resolved = await resolveTrader(supabase, { handle: id })
          if (!resolved) return null
          const { data } = await supabase
            .from('leaderboard_ranks')
            .select('handle, source, roi, arena_score, pnl')
            .eq('source', resolved.platform)
            .eq('source_trader_id', resolved.traderKey)
            .eq('season_id', '90D')
            .maybeSingle()
          return data as {
            handle: string | null
            source: string | null
            roi: number | null
            arena_score: number | null
            pnl: number | null
          } | null
        })
      )
    ).filter(Boolean) as Array<{
      handle: string | null
      source: string | null
      roi: number | null
      arena_score: number | null
      pnl: number | null
    }>
    if (rows.length === 0) return staticFallback
    const names = rows.map((r) => r.handle || 'Trader').join(',')
    const platforms = rows.map((r) => r.source || '').join(',')
    const rois = rows.map((r) => Math.round((r.roi ?? 0) * 10) / 10).join(',')
    const scores = rows.map((r) => Math.round(r.arena_score ?? 0)).join(',')
    const pnls = rows.map((r) => Math.round(r.pnl ?? 0)).join(',')
    return (
      `${BASE_URL}/api/og/compare?names=${encodeURIComponent(names)}` +
      `&platforms=${encodeURIComponent(platforms)}&rois=${rois}&scores=${scores}&pnls=${pnls}`
    )
  } catch {
    return staticFallback
  }
}

export async function generateMetadata(props: {
  searchParams?: Promise<{ ids?: string }>
}): Promise<Metadata> {
  const resolved = props.searchParams ? await props.searchParams : {}
  const ids = resolved.ids
  const idList = ids ? ids.split(',').slice(0, 3) : []

  const ogUrl = await buildCompareOgUrl(idList)

  const title = 'Compare Traders'
  const description =
    idList.length > 0
      ? `Comparing ${idList.length} traders side-by-side on Arena`
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
      url: `${BASE_URL}/compare${ids ? '?ids=' + ids : ''}`,
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
