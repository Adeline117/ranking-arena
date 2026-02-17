import { Suspense } from 'react'
import { HomePage } from './components/home'
import { getInitialTraders } from '@/lib/getInitialTraders'
import SSRRankingTable from './components/home/SSRRankingTable'

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
export default async function Page() {
  const { traders: initialTraders, lastUpdated } = await getInitialTraders('90D', 25)

  return (
    <>
      {/* SSR ranking table — LCP element, hidden by CSS :has() when client renders */}
      <div id="ssr-ranking">
        <SSRRankingTable traders={initialTraders} />
      </div>

      <Suspense fallback={null}>
        <HomePage
          initialTraders={initialTraders}
          initialLastUpdated={lastUpdated}
        />
      </Suspense>
    </>
  )
}
