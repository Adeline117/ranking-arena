import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { unstable_cache } from 'next/cache'
import RankingsIndexClient from './RankingsIndexClient'
import { BASE_URL } from '@/lib/constants/urls'
import { getSupabaseAdmin } from '@/lib/supabase/server'

export const revalidate = 300 // ISR: 5 min

export const metadata: Metadata = {
  title: 'Crypto Trader Rankings | Top Traders',
  description: 'Crypto trader rankings across 30+ exchanges. Compare ROI, win rate, and Arena Score from Binance, Bitget, Bybit, OKX. Updated every 3 hours.',
  alternates: {
    canonical: `${BASE_URL}/rankings`,
  },
  openGraph: {
    title: 'Crypto Trader Rankings',
    description: 'Multi-dimensional trader rankings across 30+ exchanges. Compare ROI, win rate, Arena Score, and more. Updated every 3 hours.',
    url: `${BASE_URL}/rankings`,
    siteName: 'Arena',
    type: 'website',
    images: [{
      url: `${BASE_URL}/og-image.png`,
      width: 1200,
      height: 630,
      alt: 'Arena - Crypto Trader Rankings'
    }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Crypto Trader Rankings',
    description: 'Multi-dimensional trader rankings across 30+ exchanges. Compare ROI, win rate, and Arena Score.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

// Prefetch platform stats server-side for SSR
const getPlatformStats = unstable_cache(
  async () => {
    try {
      const supabase = getSupabaseAdmin()
      const { data, error } = await supabase
        .from('leaderboard_ranks')
        .select('source, arena_score, roi, win_rate')
        .eq('season_id', '90D')
        .not('arena_score', 'is', null)
        .gt('arena_score', 0)
        .or('is_outlier.is.null,is_outlier.eq.false')

      if (error || !data?.length) return []

      const stats = new Map<string, { count: number; totalScore: number; totalRoi: number; winRateCount: number; totalWinRate: number; scores: number[] }>()
      for (const row of data) {
        if (!row.source || row.arena_score == null) continue
        if (!stats.has(row.source)) {
          stats.set(row.source, { count: 0, totalScore: 0, totalRoi: 0, winRateCount: 0, totalWinRate: 0, scores: [] })
        }
        const s = stats.get(row.source)!
        s.count++
        s.totalScore += Number(row.arena_score)
        s.totalRoi += Number(row.roi ?? 0)
        s.scores.push(Number(row.arena_score))
        if (row.win_rate != null && Number(row.win_rate) > 0) {
          s.winRateCount++
          s.totalWinRate += Number(row.win_rate)
        }
      }

      return [...stats.entries()].map(([platform, s]) => {
        const sorted = s.scores.sort((a, b) => a - b)
        const mid = Math.floor(sorted.length / 2)
        return {
          platform,
          traderCount: s.count,
          avgScore: Math.round((s.totalScore / s.count) * 100) / 100,
          avgRoi: Math.round((s.totalRoi / s.count) * 100) / 100,
          medianScore: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
          avgWinRate: s.winRateCount > 0 ? Math.round((s.totalWinRate / s.winRateCount) * 100) / 100 : null,
        }
      }).sort((a, b) => b.traderCount - a.traderCount)
    } catch {
      return []
    }
  },
  ['rankings-platform-stats'],
  { revalidate: 300, tags: ['rankings'] }
)

// Handle legacy ?platform=xxx and ?ex=xxx query params used by old share links and external references.
// e.g. /rankings?platform=dydx  → /rankings/dydx
//      /rankings?ex=hyperliquid → /rankings/hyperliquid
//      /rankings (bare)         → / (homepage)
export default async function RankingsPage({
  searchParams,
}: {
  searchParams: Promise<{ platform?: string; ex?: string }>
}) {
  const params = await searchParams
  const exchange = params.platform || params.ex

  if (exchange) {
    // Redirect to the canonical exchange rankings page
    redirect(`/rankings/${encodeURIComponent(exchange)}`)
  }

  const initialPlatforms = await getPlatformStats()

  // Show exchange index page with SSR data
  return <RankingsIndexClient initialPlatforms={initialPlatforms} />
}
