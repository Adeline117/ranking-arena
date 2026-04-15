import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getHeroStats } from '@/lib/data/hero-stats'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import RankingControls from './components/home/RankingControls'
import TopNav from './components/layout/TopNav'
import BetaBanner from './components/layout/BetaBanner'
import WelcomeBanner from './components/home/WelcomeBanner'
import HomePageLoader from './components/home/HomePageLoader'
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

const PER_PAGE = 50
const VALID_RANGES = new Set(['7D', '30D', '90D'])

/**
 * Homepage — Two-phase SSR + interactive rendering.
 *
 * Phase 1 (SSR): Hero + ranking table render as pure HTML in the initial payload.
 *   LCP = FCP ≈ 1.5s. Zero JS needed to see above-fold content.
 *
 * Phase 2 (Client): HomePageLoader defers the full interactive three-column layout
 *   (discussions, watchlist, flash news) until user interaction or idle callback.
 *   When Phase 2 mounts, it replaces the SSR ranking table with the interactive version.
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

      {/* SSR TopNav — hidden when Phase 2 mounts (HomePage renders its own) */}
      <div id="ssr-topnav">
        <TopNav />
      </div>

      <BetaBanner />
      <WelcomeBanner />

      {/* SSR Hero — visible until Phase 2 replaces it */}
      <div id="ssr-hero-shell">
        <HomeHeroSSR
          traderCount={heroStats?.traderCount}
          exchangeCount={heroStats?.exchangeCount}
        />
      </div>

      {/* SSR ranking table in three-col-layout grid.
          Uses same CSS grid as Phase 2 — center column renders at final width.
          No sidebar content rendered (avoids empty placeholders hurting Speed Index).
          CSS grid reserves sidebar column space without visible empty areas. */}
      {/* SSR three-col grid — matches Phase 2 exactly. Sidebar grid tracks are
          reserved by empty divs (no height, just grid placement) so center column
          renders at the correct width from frame 1. Zero CLS on Phase 2 swap. */}
      <div id="ssr-ranking-table" className="three-col-layout">
        <div className="three-col-left hide-tablet" aria-hidden="true" />
        <div className="three-col-center">
          <div className="ssr-t" style={{ marginTop: 8 }}>
            <RankingControls
              activeRange={timeRange}
              page={page}
              totalCount={totalCount}
              perPage={PER_PAGE}
            />
            <SSRRankingTable traders={traders} startRank={page * PER_PAGE} />
          </div>
        </div>
        <div className="three-col-right hide-mobile" aria-hidden="true" />
      </div>

      {/* Phase 2: Full interactive three-column layout with sidebars.
          Loaded via next/dynamic(ssr:false) — deferred until user interaction.
          Left: HotDiscussions | Center: Interactive rankings | Right: Watchlist + FlashNews
          Providers are inside HomePageLoader (client-side only) to avoid hydration mismatch. */}
      <PageErrorBoundary>
        <HomePageLoader
          initialTraders={traders}
          initialLastUpdated={lastUpdated}
          heroStats={heroStats}
          initialTotalCount={totalCount}
          initialCategoryCounts={categoryCounts}
        />
      </PageErrorBoundary>
    </>
  )
}
