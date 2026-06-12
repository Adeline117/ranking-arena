/**
 * Server shell for /search (Wave-3 SSR conversion).
 *
 * The shell streams immediately (metadata lives in layout.tsx); the
 * interactive body — useSearchParams, React Query, auth — stays in the
 * client leaf behind Suspense. No data fetching moved to the server yet.
 */

import { Suspense } from 'react'
import { SearchPageSkeleton } from '@/app/components/ui/PageSkeleton'
import SearchPageClient from './SearchPageClient'

export default function SearchPage() {
  return (
    <Suspense fallback={<SearchPageSkeleton />}>
      <SearchPageClient />
    </Suspense>
  )
}
