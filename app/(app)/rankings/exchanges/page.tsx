/**
 * Exchange Rankings (ARENA_DATA_SPEC v1.2 §6.1, plan E.11): which exchange's
 * copy traders actually make money — board-level aggregates per serving
 * source, computed entirely from arena.* serving tables (zero extra
 * scraping). Request-rendered with a 30-minute data cache; gated behind >= 3
 * non-legacy sources so it only surfaces once the cross-exchange comparison
 * is meaningful.
 */

import type { Metadata } from 'next'
import { unstable_cache } from 'next/cache'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { BASE_URL } from '@/lib/constants/urls'
import {
  getExchangeRankings,
  type ExchangeRankings,
  type ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'
import ExchangeRankingsClient from './ExchangeRankingsClient'

// These RPCs read an external serving dataset and can transiently exceed the
// database statement timeout. Pre-rendering this route made an upstream blip
// fail the entire production build. Keep the route request-rendered so deploys
// do not depend on live database availability, while retaining the 30-minute
// data cache and the existing runtime error boundary/retry semantics.
export const dynamic = 'force-dynamic'

const MIN_SERVING_SOURCES = 3
const getCachedExchangeRankings = unstable_cache(
  (timeframe: ExchangeRankingsTimeframe) => getExchangeRankings(getReadReplica(), timeframe),
  ['rankings-exchange-rankings-v1'],
  { revalidate: 1800, tags: ['rankings', 'exchange-rankings'] }
)

export const metadata: Metadata = {
  title: 'Exchange Rankings — Copy Trading Leaderboards Compared',
  description:
    "Which source board's ranked traders show the strongest historical results? Compare median and top-decile ROI, percent profitable, copier PnL, and bot share from the latest published leaderboard.",
  alternates: { canonical: `${BASE_URL}/rankings/exchanges` },
  keywords: [
    'exchange ranking',
    'copy trading comparison',
    'best copy trading exchange',
    'copy trading ROI by exchange',
    'crypto exchange leaderboard',
  ],
  openGraph: {
    title: 'Exchange Rankings — Copy Trading Leaderboards Compared',
    description:
      'Compare ranked traders, median ROI, % profitable, copier PnL and bot share across exchanges.',
    url: `${BASE_URL}/rankings/exchanges`,
    siteName: 'Arena',
    type: 'website',
    images: [
      { url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena Exchange Rankings' },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Exchange Rankings — Copy Trading Compared',
    description:
      'Compare ranked traders, median ROI, % profitable, copier PnL and bot share across exchanges.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

const TIMEFRAMES: ExchangeRankingsTimeframe[] = [7, 30, 90]

export default async function ExchangeRankingsPage() {
  const settled = await Promise.allSettled(
    TIMEFRAMES.map((timeframe) => getCachedExchangeRankings(timeframe))
  )
  const byTimeframe = {} as Record<ExchangeRankingsTimeframe, ExchangeRankings | null>
  const failedTimeframes: ExchangeRankingsTimeframe[] = []

  settled.forEach((result, index) => {
    const timeframe = TIMEFRAMES[index]
    if (result.status === 'fulfilled') {
      byTimeframe[timeframe] = result.value
      return
    }
    byTimeframe[timeframe] = null
    failedTimeframes.push(timeframe)
  })

  if (failedTimeframes.length === TIMEFRAMES.length) {
    throw new AggregateError(
      settled.flatMap((result) => (result.status === 'rejected' ? [result.reason] : [])),
      'Exchange rankings are unavailable'
    )
  }

  // Gate (plan E.11): the page only exists once >= 3 sources read from
  // arena.* — below that a cross-exchange comparison is noise, not signal.
  // A transient serving-data gap must NOT 404 a core rankings page: its
  // 30-minute data cache and sitemap entry would amplify the SEO damage.
  // Render the client's i18n'd "no data yet" empty state instead (TopNav
  // stays interactive) and log loudly so the gap is not silent.
  const gateCount = Math.max(
    0,
    ...TIMEFRAMES.map((timeframe) => byTimeframe[timeframe]?.nonLegacyCount ?? 0)
  )
  if (gateCount < MIN_SERVING_SOURCES) {
    console.error(
      `[serving-gate] /rankings/exchanges gate triggered (nonLegacyCount=${gateCount} < ${MIN_SERVING_SOURCES}) — rendering empty state instead of 404`
    )
    for (const timeframe of TIMEFRAMES) {
      const data = byTimeframe[timeframe]
      if (data) byTimeframe[timeframe] = { ...data, rows: [] }
    }
  }

  return <ExchangeRankingsClient byTimeframe={byTimeframe} failedTimeframes={failedTimeframes} />
}
