/**
 * Weekly Cross-Exchange ROI Arena (ARENA_DATA_SPEC v1.2 §12.6
 * counter-feature): BitMart runs a weekly single-exchange "ROI Arena" —
 * this page pools the same weekly competition ACROSS every serving source
 * (top 7d-ROI traders from each board's latest PASSED snapshot), with
 * BitMart's official weekly results as a reference panel. SSR + ISR; gated
 * behind >= 3 non-legacy sources like /rankings/exchanges.
 */

import type { Metadata } from 'next'
import { getReadReplica } from '@/lib/supabase/read-replica'
import { BASE_URL } from '@/lib/constants/urls'
import { getWeeklyLeaders } from '@/lib/data/serving/weekly-leaders'
import WeeklyArenaClient from './WeeklyArenaClient'

export const revalidate = 1800 // ISR: 30 minutes

const MIN_SERVING_SOURCES = 3
const LEADER_LIMIT = 50

export const metadata: Metadata = {
  title: 'Weekly Cross-Exchange ROI Arena — This Week’s Top Traders',
  description:
    'The weekly ROI competition no single exchange can run: this week’s top 7-day ROI copy traders ranked across every exchange Arena tracks, with BitMart’s official weekly arena as reference.',
  alternates: { canonical: `${BASE_URL}/rankings/weekly` },
  keywords: [
    'weekly trading competition',
    'weekly ROI leaderboard',
    'cross-exchange trader ranking',
    'copy trading weekly winners',
    'crypto trading arena',
  ],
  openGraph: {
    title: 'Weekly Cross-Exchange ROI Arena',
    description:
      'This week’s top 7-day ROI traders ranked across every exchange Arena tracks — the competition no single exchange can run.',
    url: `${BASE_URL}/rankings/weekly`,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: `${BASE_URL}/og-image.png`,
        width: 1200,
        height: 630,
        alt: 'Arena Weekly Cross-Exchange ROI Arena',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Weekly Cross-Exchange ROI Arena',
    description: 'This week’s top 7-day ROI traders ranked across every exchange Arena tracks.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

export default async function WeeklyArenaPage() {
  const data = await getWeeklyLeaders(getReadReplica(), LEADER_LIMIT)

  // Same gate as /rankings/exchanges: below 3 serving sources a
  // cross-exchange weekly competition is noise, not signal. A transient
  // serving-data gap must NOT 404 a core rankings page — with ISR
  // (revalidate 1800) a notFound() here gets pinned in the cache for up to
  // 30 minutes and this page is in the sitemap, amplifying the SEO damage.
  // Render the client's i18n'd "no data yet" empty state instead (TopNav
  // stays interactive) and log loudly so the gap is not silent.
  if (data.nonLegacyCount < MIN_SERVING_SOURCES) {
    console.error(
      `[serving-gate] /rankings/weekly gate triggered (nonLegacyCount=${data.nonLegacyCount} < ${MIN_SERVING_SOURCES}) — rendering empty state instead of 404`
    )
    return (
      <WeeklyArenaClient data={{ nonLegacyCount: data.nonLegacyCount, rows: [], bitmart: null }} />
    )
  }

  return <WeeklyArenaClient data={data} />
}
