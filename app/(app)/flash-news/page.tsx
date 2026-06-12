/**
 * Server shell for /flash-news (SSR conversion batch 3).
 * Interactive body stays in the client leaf behind Suspense.
 */

import { Suspense } from 'react'
import { FlashNewsPageSkeleton } from '@/app/components/ui/PageSkeleton'
import FlashNewsPageClient from './FlashNewsPageClient'

export default function FlashNewsPage() {
  return (
    <Suspense fallback={<FlashNewsPageSkeleton />}>
      <FlashNewsPageClient />
    </Suspense>
  )
}
