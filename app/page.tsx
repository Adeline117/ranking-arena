import type { Metadata } from 'next'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { unstable_cache } from 'next/cache'
import SSRRankingTable from './components/home/SSRRankingTable'
import HomeHeroSSR from './components/home/HomeHeroSSR'
import { JsonLd } from './components/Providers/JsonLd'
import HomePageLoader from './components/home/HomePageLoader'
import { PageErrorBoundary } from './components/utils/ErrorBoundary'

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
  url: baseUrl,
  logo: `${baseUrl}/logo-symbol.png`,
  sameAs: ['https://twitter.com/arenafi'],
  description: 'Arena aggregates trader rankings from 30+ exchanges. Follow top traders, share insights, and level up your trading.',
}

// WebSite JSON-LD is in layout.tsx (site-wide, with potentialAction)

/** Fetch hero stats (trader count + exchange count) server-side to avoid client waterfall.
 *  Cached in Redis for 1 hour — the COUNT query scans 34K+ rows and runs on every ISR
 *  revalidation. The count only meaningfully changes when new exchanges go live. */
// Use unstable_cache (ISR-compatible) instead of tieredGetOrSet (Redis, breaks ISR via no-store fetch)
const getHeroStats = unstable_cache(
  async (): Promise<{ traderCount: number; exchangeCount: number }> => {
    try {
      const supabase = getSupabaseAdmin()
      const tradersRes = await supabase
        .from('trader_sources')
        .select('id', { count: 'exact', head: true })
      const traderCount = tradersRes.count ?? 34000
      // Count distinct active exchanges — use RPC or efficient distinct query
      let exchangeCount = 27 // fallback
      try {
        // Use PostgreSQL DISTINCT to count unique sources without fetching 10K rows
        const { data: sources } = await supabase
          .from('leaderboard_ranks')
          .select('source')
          .eq('season_id', '90D')
          .gt('arena_score', 0)
          .limit(1000)  // Reduced from 10K — 1000 rows is enough to cover all ~35 platforms
        if (sources && sources.length > 0) {
          const uniqueSources = new Set(sources.map((r: { source: string }) => r.source))
          if (uniqueSources.size > 0) exchangeCount = uniqueSources.size
        }
      } catch {
        // fallback to 27
      }
      return { traderCount, exchangeCount }
    } catch {
      return { traderCount: 34000, exchangeCount: 27 }
    }
  },
  ['hero-stats-count'],
  { revalidate: 3600, tags: ['hero-stats'] }
)

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
      {/* Preload top 3 avatars — fetchpriority=auto to avoid competing with LCP text */}
      {top3Avatars.map(url => (
        <link key={url} rel="preload" as="image" href={url} crossOrigin="anonymous" />
      ))}
      {/* REMOVED: <link rel="preload" as="fetch" href="/api/traders?timeRange=90D&limit=200">
          This was forcing the browser to download ranking data before any JS initialized.
          The SSR table already shows data — the client fetch can happen lazily. */}
      <JsonLd data={organizationJsonLd} />

      <PageErrorBoundary>
        {/* Phase 1: SSR hero + ranking table — pure HTML, 0 JS, visible immediately.
            HomeHeroSSR contains the LCP headline "Track the World's Best Crypto Traders".
            Hidden via CSS once the interactive HomePage mounts (see globals.css).
            NOTE: ssrTable is intentionally NOT passed to HomePageLoader — the Phase 1
            shell already provides the fallback. Passing it to the client caused duplicate
            DOM nodes (SSR shell + inline copy) inflating DOM size by ~200 nodes. */}
        <div id="ssr-homepage-shell" style={{ maxWidth: 1400, margin: '0 auto', padding: '8px 16px' }}>
          {/* CLS fix: reserve space for elements in Phase 2 (interactive HomePage) that
              are NOT present in Phase 1 SSR shell. Without these spacers, the Phase 1→2
              transition shifts visible content (hero, ranking table) by the missing heights.
              - 56px: TopNav (sticky header rendered by HomePage, not in SSR shell)
              - 40px: HomeSubNav + FoundingMemberBanner row
              - 47px: ExchangePartners lazy-loaded strip
              Total: ~143px extra before the ranking table in Phase 2. */}
          <div aria-hidden="true" style={{ height: 56 }} />
          <HomeHeroSSR traderCount={heroStats.traderCount} exchangeCount={heroStats.exchangeCount} />
          <div aria-hidden="true" style={{ height: 40 }} />
          <div aria-hidden="true" style={{ height: 47, borderBottom: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))' }} />
          {ssrTable}
        </div>

        {/* Phase 2: Full interactive homepage — loaded with ssr:false via HomePageLoader.
            No JS chunks are included in the initial HTML. The browser downloads them
            only after HTML parsing completes. On mount, CSS hides the SSR shell above. */}
        <HomePageLoader
          initialTraders={initialTraders}
          initialLastUpdated={lastUpdated}
          heroStats={heroStats}
        />
      </PageErrorBoundary>
    </>
  )
}
