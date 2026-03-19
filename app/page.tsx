import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import SSRRankingTable from './components/home/SSRRankingTable'
import { JsonLd } from './components/Providers/JsonLd'
import HomePageLoader from './components/home/HomePageLoader'
import { ErrorBoundary } from './components/ui/ErrorBoundary'

const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://www.arenafi.org'

export const metadata: Metadata = {
  title: 'Arena — Crypto Trader Rankings & Community',
  description: 'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
  alternates: {
    canonical: baseUrl,
  },
  openGraph: {
    title: 'Arena — Crypto Trader Rankings & Community',
    description: 'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
    url: baseUrl,
    siteName: 'Arena',
    type: 'website',
    images: [{ url: `${baseUrl}/og-image.png`, width: 1200, height: 630, alt: 'Arena - Crypto Trader Rankings' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Arena — Crypto Trader Rankings & Community',
    description: 'Discover and rank the best crypto traders. Real-time performance leaderboards, community discussions, and trading resources.',
    images: [`${baseUrl}/og-image.png`],
    creator: '@arenafi',
  },
}

// ISR: Revalidate every 5 minutes (300s)
// CDN serves stale content while revalidating in background
export const revalidate = 300

/**
 * Homepage — Two-phase rendering for extreme LCP optimization:
 *
 * Phase 1 (SSR): SSRRankingTable renders as pure static HTML.
 *   - Zero JS chunks in initial HTML payload
 *   - On slow 4G (1.6 Mbps), LCP is ~1-2s instead of 10s+
 *
 * Phase 2 (Client): HomePageLoader uses next/dynamic(ssr:false) to lazy-load
 *   the full interactive HomePage AFTER the browser finishes parsing HTML.
 *   When HomePage mounts, it hides the SSR table via CSS class swap.
 *
 * Key: HomePageLoader is a 'use client' wrapper so we can use ssr:false
 * (not allowed directly in Server Components).
 */
// Site-level JSON-LD structured data
const organizationJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'Organization',
  name: 'Arena',
  url: baseUrl,
  logo: `${baseUrl}/logo-symbol.png`,
  sameAs: ['https://twitter.com/arenafi'],
  description: 'Arena aggregates trader rankings from 30+ exchanges. Follow top traders, share insights, and level up your trading.',
}

// WebSite JSON-LD is in layout.tsx (site-wide, with potentialAction)

/** Fetch hero stats (trader count + exchange count) server-side to avoid client waterfall */
async function getHeroStats(): Promise<{ traderCount: number; exchangeCount: number }> {
  try {
    const supabase = getSupabaseAdmin()
    // Only fetch trader count — exchange count is static (changes at most once a month)
    // Use trader_sources for a fast index-only count scan
    const tradersRes = await supabase
      .from('trader_sources')
      .select('id', { count: 'exact', head: true })
    const traderCount = tradersRes.count ?? 34000
    // Exchange count is updated manually when new exchanges go live
    const exchangeCount = 27
    return { traderCount, exchangeCount }
  } catch {
    return { traderCount: 34000, exchangeCount: 27 }
  }
}

export default async function Page() {
  const [{ traders: initialTraders, lastUpdated }, heroStats] = await Promise.all([
    getInitialTraders('90D', 50),
    getHeroStats(),
  ])

  // Preload top 3 trader avatars — use direct CDN URLs (avoids /api/avatar proxy roundtrip)
  const top3Avatars = initialTraders
    .slice(0, 3)
    .filter(t => t.avatar_url && !t.avatar_url.startsWith('/'))
    .map(t => t.avatar_url!)

  const ssrTable = <SSRRankingTable traders={initialTraders} />

  return (
    <>
      {/* Preload top 3 avatars for faster LCP — direct CDN URLs */}
      {top3Avatars.map(url => (
        <link key={url} rel="preload" as="image" href={url} crossOrigin="anonymous" />
      ))}
      {/* REMOVED: <link rel="preload" as="fetch" href="/api/traders?timeRange=90D&limit=200">
          This was forcing the browser to download ranking data before any JS initialized.
          The SSR table already shows data — the client fetch can happen lazily. */}
      <JsonLd data={organizationJsonLd} />

      <ErrorBoundary name="homepage">
        {/* Phase 1: Static SSR ranking table — renders instantly as pure HTML, 0 JS.
            Hidden via CSS once the interactive HomePage mounts (see globals.css). */}
        <div id="ssr-homepage-shell" style={{ maxWidth: 1400, margin: '0 auto', padding: '8px 16px' }}>
          {ssrTable}
        </div>

        {/* Phase 2: Full interactive homepage — loaded with ssr:false via HomePageLoader.
            No JS chunks are included in the initial HTML. The browser downloads them
            only after HTML parsing completes. On mount, HomePage adds a class that
            hides the SSR shell above via CSS. */}
        <HomePageLoader
          initialTraders={initialTraders}
          initialLastUpdated={lastUpdated}
          heroStats={heroStats}
          ssrTable={ssrTable}
        />
      </ErrorBoundary>
    </>
  )
}
