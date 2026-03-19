import type { Metadata } from 'next'
import { Suspense } from 'react'
import { getInitialTraders } from '@/lib/getInitialTraders'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import SSRRankingTable from './components/home/SSRRankingTable'
import { JsonLd } from './components/Providers/JsonLd'
import { HomePage } from './components/home'
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
 * 首页 - Two-phase rendering for LCP:
 *
 * Phase 1: SSRRankingTable renders as static HTML — instant LCP, no JS needed.
 * Phase 2: HomePage client component hydrates. CSS :has() hides SSR table
 *          the moment .home-ranking-section appears in DOM. Zero CLS.
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
    const [tradersRes, platformsRes] = await Promise.all([
      supabase.from('traders').select('id', { count: 'exact', head: true }),
      supabase.from('leaderboard_ranks').select('source').eq('season_id', '90D').limit(200),
    ])
    const traderCount = tradersRes.count ?? 34000
    let exchangeCount = 27
    if (platformsRes.data) {
      const platforms = new Set(platformsRes.data.map((r: { source: string }) =>
        r.source.replace(/_(futures|spot|web3|perps|network)$/, '')
      ))
      exchangeCount = Math.max(platforms.size, 27)
    }
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

  return (
    <>
      {/* Preload top 3 avatars for faster LCP — direct CDN URLs */}
      {top3Avatars.map(url => (
        <link key={url} rel="preload" as="image" href={url} crossOrigin="anonymous" />
      ))}
      <JsonLd data={organizationJsonLd} />
      {/* SSR ranking table — LCP element, hidden by CSS :has() when client renders */}
      <div id="ssr-ranking">
        <SSRRankingTable traders={initialTraders} />
      </div>

      <ErrorBoundary name="homepage">
        <Suspense fallback={null}>
          <HomePage initialTraders={initialTraders} initialLastUpdated={lastUpdated} heroStats={heroStats} />
        </Suspense>
      </ErrorBoundary>
    </>
  )
}
