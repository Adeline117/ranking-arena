import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getHeroStats } from '@/lib/data/hero-stats'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import RankingControls from './components/home/RankingControls'
import TopNav from './components/layout/TopNav'
import HomePageLoader from './components/home/HomePageLoader'
import { JsonLd } from './components/Providers/JsonLd'
import { PageErrorBoundary } from './components/utils/ErrorBoundary'
import { BASE_URL } from '@/lib/constants/urls'
import type { Period } from '@/lib/utils/arena-score'

export const metadata: Metadata = {
  title: 'Arena | Crypto Trader Rankings & Community',
  description:
    'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
  alternates: {
    canonical: BASE_URL,
  },
  openGraph: {
    title: 'Arena | Crypto Trader Rankings & Community',
    description:
      'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
    url: BASE_URL,
    siteName: 'Arena',
    type: 'website',
    images: [
      {
        url: `${BASE_URL}/api/og/homepage`,
        width: 1200,
        height: 630,
        alt: 'Arena - Crypto Trader Rankings',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena | Crypto Trader Rankings & Community',
    description:
      'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
    images: [`${BASE_URL}/api/og/homepage`],
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
  description:
    'Arena aggregates trader rankings from 30+ exchanges. Follow top traders, share insights, and level up your trading.',
}

const PER_PAGE = 50
const _VALID_RANGES = new Set(['7D', '30D', '90D'])

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
// SSR always renders default view (90D, page 0) for edge cacheability.
// Client-side HomePageLoader reads searchParams via useSearchParams() and
// switches to the requested range/page after hydration.
// ROOT CAUSE FIX: reading searchParams server-side made Next.js mark the page
// as dynamic → no edge cache → every request hit Tokyo origin.
export default async function Page() {
  const timeRange: Period = '90D'
  const page = 0

  // Fetch data in parallel
  const [{ traders, lastUpdated, totalCount, categoryCounts }, heroStats] = await Promise.all([
    getInitialTraders(timeRange, PER_PAGE, page),
    getHeroStats(),
  ])

  return (
    <main id="main-content">
      <JsonLd data={organizationJsonLd} />

      {/* SSR TopNav — hidden when Phase 2 mounts (HomePage renders its own) */}
      <div id="ssr-topnav">
        <TopNav />
      </div>

      {/* WelcomeBanner moved to HomePageLoader Phase 2 (client-only) */}

      {/* SSR Hero — stays visible permanently. Outside #ssr-ranking-table so
          Phase 2 hiding the table doesn't affect it. Constrained to center
          column width via max-width + margin for alignment with three-col grid. */}
      <div id="ssr-hero-shell" style={{ maxWidth: 1400, margin: '0 auto', padding: '0 20px' }}>
        <HomeHeroSSR
          traderCount={heroStats?.traderCount}
          exchangeCount={heroStats?.exchangeCount}
        />
      </div>

      {/* SSR ranking table — visible until React takes over.
          The HomePageClient useLayoutEffect hides this BEFORE first paint
          (when initialTraders is provided, loading starts as false).
          On slow mobile without JS, this stays visible as the primary content. */}
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

      <PageErrorBoundary>
        <HomePageLoader
          initialTraders={traders}
          initialLastUpdated={lastUpdated}
          heroStats={heroStats}
          initialTotalCount={totalCount}
          initialCategoryCounts={categoryCounts}
        />
      </PageErrorBoundary>
    </main>
  )
}
