import { Suspense } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import TopNav from '@/app/components/layout/TopNav'
import TraderPageClient from './TraderPageClient'

// ISR: cache page for 60s — data updates via cron, client-side SWR handles freshness
export const revalidate = 60

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
  )
}
