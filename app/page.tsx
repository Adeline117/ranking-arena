import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getHeroStats } from '@/lib/data/hero-stats'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import { JsonLd } from './components/Providers/JsonLd'
import HomePageLoader from './components/home/HomePageLoader'
import { PageErrorBoundary } from './components/utils/ErrorBoundary'
import { BASE_URL } from '@/lib/constants/urls'

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
// CDN serves stale content while revalidating in background
export const revalidate = 300

/**
 * Homepage — Two-phase rendering for extreme LCP optimization:
 *
 * Phase 1 (SSR): HomeHeroSSR + SSRRankingTable render as pure static HTML.
 *   - Zero JS chunks for the above-fold content
 *   - Hero headline "Track the World's Best Crypto Traders" is the LCP element
 *   - On slow 4G (1.6 Mbps), LCP is ~1-2s instead of 10s+
 *
 * Phase 2 (Client): HomePageLoader uses next/dynamic(ssr:false) to lazy-load
 *   the full interactive HomePage AFTER the browser finishes parsing HTML.
 *   When HomePage mounts, CSS hides the SSR shell (#ssr-homepage-shell).
 *
 * Key: HomePageLoader is a 'use client' wrapper so we can use ssr:false
 * (not allowed directly in Server Components).
 */
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

// WebSite JSON-LD is in layout.tsx (site-wide, with potentialAction)

export default async function Page() {
  // Fetch data in parallel for optimal performance
  const [{ traders: initialTraders, lastUpdated }, heroStats] = await Promise.all([
    getInitialTraders('90D', 10),
    getHeroStats(),
  ])

  return (
    <>
      {/* REMOVED: <link rel="preload" as="fetch" href="/api/traders?timeRange=90D&limit=200">
          This was forcing the browser to download ranking data before any JS initialized.
          The SSR table already shows data — the client fetch can happen lazily. */}
      <JsonLd data={organizationJsonLd} />

      {/* Phase 1 (SSR): Hero stays visible as LCP element even after Phase 2 loads.
          Only the ranking table is hidden (it gets replaced by the interactive table).
          Hero is kept visible because hiding it resets LCP to Phase 2 hero load time (~11s on slow 4G). */}
      <div id="ssr-hero-shell">
        <HomeHeroSSR traderCount={heroStats?.traderCount} exchangeCount={heroStats?.exchangeCount} />
      </div>
      <div id="ssr-ranking-table">
        <SSRRankingTable traders={initialTraders} />
      </div>

      <PageErrorBoundary>
        {/* Phase 2: Full interactive homepage — loaded with ssr:false via HomePageLoader. */}
        <HomePageLoader
          initialTraders={initialTraders}
          initialLastUpdated={lastUpdated}
          heroStats={heroStats}
        />
      </PageErrorBoundary>
    </>
  )
}
