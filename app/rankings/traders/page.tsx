'use client'

import { Suspense } from 'react'
import HomePageClient from '@/app/components/home/HomePageClient'
import RankingTableSkeleton from '@/app/components/home/RankingTableSkeleton'

/**
 * /rankings/traders — reuses the same RankingSection from the homepage
 * so the UI is identical. The sub-nav is provided by the rankings layout.
 */
export default function RankingsTradersPage() {
  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '0 16px 40px' }}>
      <Suspense fallback={<RankingTableSkeleton />}>
        <HomePageClient />
      </Suspense>
    </div>
  )
}
