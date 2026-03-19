'use client'

import dynamic from 'next/dynamic'
import type { InitialTrader } from '@/lib/getInitialTraders'

/**
 * HomePageLoader — thin client wrapper that lazy-loads the entire HomePage
 * with ssr: false. This means:
 *
 * 1. The SSR HTML contains ONLY the static ranking table — zero JS chunks
 * 2. HomePage (and its ~275 transitive JS chunks) are NOT included in the
 *    initial HTML as <script> tags
 * 3. JS loading begins only after the browser finishes parsing the HTML
 * 4. On slow 4G (1.6 Mbps), this turns a 10s LCP into a <2s LCP
 *
 * The SSR ranking table is rendered directly by page.tsx (outside this component)
 * and hidden via CSS once HomePage mounts.
 */
const HomePage = dynamic(() => import('./HomePage'), {
  ssr: false,
  loading: () => null, // SSR table is already visible — no loading skeleton needed
})

interface HomePageLoaderProps {
  initialTraders?: InitialTrader[]
  initialLastUpdated?: string | null
  heroStats?: { traderCount: number; exchangeCount: number }
}

export default function HomePageLoader(props: HomePageLoaderProps) {
  return <HomePage {...props} />
}
