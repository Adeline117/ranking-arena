import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getHeroStats } from '@/lib/data/hero-stats'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import RankingControls from './components/home/RankingControls'
import { JsonLd } from './components/Providers/JsonLd'
import { PageErrorBoundary } from './components/utils/ErrorBoundary'
import { BASE_URL } from '@/lib/constants/urls'
import type { Period } from '@/lib/utils/arena-score'

export const metadata: Metadata = {
  title: 'Arena — Crypto Trader Rankings & Community',
  description: 'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
  alternates: {
    canonical: BASE_URL,
  },
  openGraph: {
    title: 'Arena — Crypto Trader Rankings & Community',
    description: 'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
    url: BASE_URL,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${BASE_URL}/og-image.png`, width: 1200, height: 630, alt: 'Arena - Crypto Trader Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena — Crypto Trader Rankings & Community',
    description: 'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
    images: [`${BASE_URL}/og-image.png`],
    creator: '@arenafi',
  },
}

// ISR: Revalidate every 5 minutes (300s)
export const revalidate = 300

// Site-level JSON-LD structured data
const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Arena',
  url: BASE_URL,
  logo: `${BASE_URL}/logo-symbol.png`,
  sameAs: ['https://twitter.com/arenafi'],
  description: 'Arena aggregates trader rankings from 30+ exchanges. Follow top traders, share insights, and level up your trading.',
}

const PER_PAGE = 25
const VALID_RANGES = new Set(['7D', '30D', '90D'])

/**
 * Homepage — Single-phase SSR architecture.
 *
 * The ranking table is 100% server-rendered. No client-side re-rendering.
 * JS is only loaded for interactive controls (time range switch, pagination)
 * which use router.push() to trigger a new server render.
 *
 * LCP = FCP ≈ 1.5s because the table is in the initial HTML payload.
 * Zero JS needed to see the complete leaderboard.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const sp = await searchParams
  const rawRange = typeof sp?.range === 'string' ? sp.range : '90D'
  const timeRange = (VALID_RANGES.has(rawRange) ? rawRange : '90D') as Period
  const page = Math.max(0, parseInt(typeof sp?.page === 'string' ? sp.page : '0', 10) || 0)

  // Fetch data in parallel
  const [{ traders, lastUpdated, totalCount, categoryCounts }, heroStats] = await Promise.all([
    getInitialTraders(timeRange, PER_PAGE, page),
    getHeroStats(),
  ])

  return (
    <>
      <JsonLd data={organizationJsonLd} />

      {/* Hero — LCP element. Pure server HTML, zero JS. */}
      <HomeHeroSSR traderCount={heroStats?.traderCount} exchangeCount={heroStats?.exchangeCount} />

      {/* Ranking table — 100% SSR. No Phase 2 replacement.
          Controls (time range + pagination) are a tiny client island (~3KB).
          Table rows are pure server HTML — no JS needed to display them. */}
      <PageErrorBoundary>
        <div className="ssr-t" style={{ marginTop: 8 }}>
          <Suspense>
            <RankingControls
              activeRange={timeRange}
              page={page}
              totalCount={totalCount}
              perPage={PER_PAGE}
            />
          </Suspense>
          <SSRRankingTable traders={traders} startRank={page * PER_PAGE} />
        </div>
      </PageErrorBoundary>
    </>
  )
}
