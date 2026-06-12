/**
 * Server shell for /competitions (SSR conversion batch 3).
 * Interactive body stays in the client leaf behind Suspense.
 */

import { Suspense } from 'react'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import CompetitionsPageClient from './CompetitionsPageClient'

export default function CompetitionsPage() {
  return (
    <Suspense fallback={<RankingSkeleton />}>
      <CompetitionsPageClient />
    </Suspense>
  )
}
