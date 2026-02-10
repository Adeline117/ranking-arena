import { Suspense } from 'react'
import { createClient } from '@supabase/supabase-js'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'
import TraderPageClient from './TraderPageClient'
import ErrorBoundary from '@/app/components/error/ErrorBoundary'

// ISR: cache page for 60s — data updates via cron, client-side SWR handles freshness
export const revalidate = 60

// Pre-render top 50 trader pages at build time for instant TTFB
export async function generateStaticParams() {
  try {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || ''
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || ''
    if (!supabaseUrl || !supabaseKey) return []
    
    const supabase = createClient(supabaseUrl, supabaseKey)
    // Use trader_sources (real data) instead of legacy traders table
    // Join with snapshots to get high-follower traders for pre-rendering
    const { data } = await supabase
      .from('trader_sources')
      .select('handle')
      .not('handle', 'is', null)
      .order('created_at', { ascending: false })
      .limit(50)
    
    return (data || [])
      .filter((t: { handle: string | null }) => t.handle)
      .map((t: { handle: string }) => ({ handle: encodeURIComponent(t.handle) }))
  } catch {
    return []
  }
}

async function fetchTraderData(handle: string) {
  try {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
    const res = await fetch(
      `${baseUrl}/api/traders/${encodeURIComponent(handle)}`,
      { next: { revalidate: 60 } }
    )
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

export default async function TraderPage({ params }: { params: Promise<{ handle: string }> }) {
  const { handle } = await params

  // Decode handle the same way the client used to
  let decodedHandle = handle
  try {
    decodedHandle = decodeURIComponent(handle)
  } catch {
    // keep original if decode fails
  }

  // Server-side data prefetch — eliminates client waterfall
  const serverData = await fetchTraderData(decodedHandle)

  return (
    <ErrorBoundary 
      pageType="trader" 
      onError={(error, errorInfo) => {
        console.error('Trader page error:', error, errorInfo)
      }}
    >
      <Suspense fallback={
        <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
          <TopNav email={null} />
          <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
            <RankingSkeleton />
          </Box>
        </Box>
      }>
        <TraderPageClient handle={decodedHandle} serverData={serverData} />
      </Suspense>
    </ErrorBoundary>
  )
}
