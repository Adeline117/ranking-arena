/**
 * Server shell for /compare (SSR conversion batch 3).
 * Interactive body stays in the client leaf behind Suspense.
 */

import { Suspense } from 'react'
import { ComparePageSkeleton } from '@/app/components/ui/PageSkeleton'
import ComparePageClient from './ComparePageClient'

// Root layout template appends ' | Arena', so omit it here to avoid doubling.
export const metadata = { title: 'Compare Traders' }

export default function ComparePage() {
  return (
    <Suspense fallback={<ComparePageSkeleton />}>
      <ComparePageClient />
    </Suspense>
  )
}
