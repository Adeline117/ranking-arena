/**
 * Exchange Rankings (ARENA_DATA_SPEC v1.2 §6.1, plan E.11): which exchange's
 * copy traders actually make money — board-level aggregates per serving
 * source, computed entirely from arena.* serving tables (zero extra
 * scraping). SSR + ISR; gated behind >= 3 non-legacy sources so it only
 * surfaces once the cross-exchange comparison is meaningful.
 */

import type { Metadata } from 'next'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { BASE_URL } from '@/lib/constants/urls'
import {
  getExchangeRankings,
  type ExchangeRankings,
  type ExchangeRankingsTimeframe,
} from '@/lib/data/serving/exchange-rankings'
import ExchangeRankingsClient from './ExchangeRankingsClient'

export const revalidate = 1800 // ISR: 30 minutes

const MIN_SERVING_SOURCES = 3

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
  const supabase = getReadReplica()
  const [tf7, tf30, tf90] = await Promise.all(
    TIMEFRAMES.map((tf) => getExchangeRankings(supabase, tf))
  )

  // Gate (plan E.11): the page only exists once >= 3 sources read from
  // arena.* — below that a cross-exchange comparison is noise, not signal.
  // A transient serving-data gap must NOT 404 a core rankings page — with
  // ISR (revalidate 1800) a notFound() here gets pinned in the cache for up
  // to 30 minutes and this page is in the sitemap, amplifying the SEO
  // damage. Render the client's i18n'd "no data yet" empty state instead
  // (TopNav stays interactive) and log loudly so the gap is not silent.
  const gateCount = tf90?.nonLegacyCount ?? tf30?.nonLegacyCount ?? tf7?.nonLegacyCount ?? 0
  if (gateCount < MIN_SERVING_SOURCES) {
    console.error(
      `[serving-gate] /rankings/exchanges gate triggered (nonLegacyCount=${gateCount} < ${MIN_SERVING_SOURCES}) — rendering empty state instead of 404`
    )
    return <ExchangeRankingsClient byTimeframe={{ 7: null, 30: null, 90: null }} />
  }

  const byTimeframe: Record<ExchangeRankingsTimeframe, ExchangeRankings | null> = {
    7: tf7,
    30: tf30,
    90: tf90,
  }

  return <ExchangeRankingsClient byTimeframe={byTimeframe} />
}
