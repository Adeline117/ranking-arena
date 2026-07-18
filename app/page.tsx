import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getHeroStats } from '@/lib/data/hero-stats'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import RankingControls from './components/home/RankingControls'
import HomeFirstPaintShell from './components/home/HomeFirstPaintShell'
import TopNav from './components/layout/TopNav'
import HomePageLoader from './components/home/HomePageLoader'
import { SkipLink } from './components/Providers/Accessibility'
import { JsonLd } from './components/Providers/JsonLd'
import { PageErrorBoundary } from './components/utils/ErrorBoundary'
import { BASE_URL } from '@/lib/constants/urls'
import {
  HOMEPAGE_TRUST_COPY,
  PRODUCT_FACTS,
  formatTrackedSourceCoverage,
} from '@/lib/config/product-facts'
import { generateTraderItemListSchema } from '@/lib/seo/structured-data'
import type { Period } from '@/lib/utils/arena-score'

export const metadata: Metadata = {
  title: 'Arena | Crypto Trader Rankings & Community',
  description: HOMEPAGE_TRUST_COPY.metadataDescription,
  alternates: {
    canonical: BASE_URL,
  },
  openGraph: {
    title: 'Arena | Crypto Trader Rankings & Community',
    description: HOMEPAGE_TRUST_COPY.metadataDescription,
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
    description: HOMEPAGE_TRUST_COPY.metadataDescription,
    images: [`${BASE_URL}/api/og/homepage`],
    creator: '@arenafi',
  },
}

// ISR: Revalidate every 5 minutes (300s)
export const revalidate = 300

// Site-level JSON-LD structured data. The hero RPC currently reports a
// deduplicated source-family count, not a canonical arena.exchanges count, so
// describe it as source coverage and fall back to neutral wording when absent.
function buildOrganizationJsonLd(exchangeCount?: number | null) {
  const sourceCoverage = formatTrackedSourceCoverage(exchangeCount)
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Arena',
    url: BASE_URL,
    logo: `${BASE_URL}/logo-symbol.png`,
    sameAs: ['https://twitter.com/arenafi'],
    description: `Arena aggregates public trader rankings from ${sourceCoverage}. Rankings are recomputed every ${PRODUCT_FACTS.leaderboardRefreshHours} hours from the latest available source data.`,
  }
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

  // ItemList for the 90D leaderboard — the actual ranking users land on. Built
  // from the SSR-fetched traders (no extra query); top 20 keeps the payload lean.
  // /rankings 301-redirects here, so this is the canonical rankings ItemList too.
  const itemListJsonLd = generateTraderItemListSchema({
    name: 'Top Crypto Traders — 90-Day Ranking',
    description: 'Top-ranked crypto traders on Arena by Arena Score over the trailing 90 days.',
    url: BASE_URL,
    numberOfItems: totalCount,
    traders: traders.slice(0, 20).map((t) => ({
      handle: t.handle,
      arenaScore: t.arena_score,
      roi: t.roi,
    })),
  })

  return (
    <>
      {/* First focusable element on the page — lets keyboard/SR users skip the
          nav. SkipLink uses useLanguage()'s hydration-safe fallback, so it works
          without Providers (homepage deliberately omits them for LCP). */}
      <SkipLink targetId="main-content" />
      <JsonLd data={buildOrganizationJsonLd(heroStats?.exchangeCount)} />
      <JsonLd data={itemListJsonLd} />

      {/* SSR TopNav — stays visible permanently (see HomePage.tsx). Outside
          <main> so the skip link actually skips it in the tab order. */}
      <div id="ssr-topnav">
        <TopNav />
      </div>

      <main id="main-content" tabIndex={-1}>
        {/* WelcomeBanner moved to HomePageLoader Phase 2 (client-only) */}

        {/* SSR Hero — stays visible permanently. Outside #ssr-ranking-table so
          Phase 2 hiding the table doesn't affect it. Constrained to center
          column width via max-width + margin for alignment with three-col grid. */}
        <div
          id="ssr-hero-shell"
          style={{ maxWidth: 1400, margin: '0 auto', padding: '12px 20px 0' }}
        >
          <HomeHeroSSR exchangeCount={heroStats?.exchangeCount} />
        </div>

        {/* Keep the final desktop information architecture visible from the
          first server paint. The old shell intentionally rendered rankings as
          one full-width column and introduced both sidebars only after a large
          client bundle arrived (25s on a throttled mobile connection). */}
        <HomeFirstPaintShell>
          <div className="ssr-t" style={{ marginTop: 8 }}>
            <RankingControls
              activeRange={timeRange}
              page={page}
              totalCount={totalCount}
              perPage={PER_PAGE}
              lastUpdated={lastUpdated}
            />
            <SSRRankingTable traders={traders} startRank={page * PER_PAGE} />
          </div>
        </HomeFirstPaintShell>

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
    </>
  )
}
