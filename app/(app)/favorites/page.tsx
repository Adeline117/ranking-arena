/**
 * Server shell for /favorites (Wave-3 SSR conversion).
 *
 * The shell streams immediately (metadata lives in layout.tsx); the
 * interactive body — auth session, bookmark folders fetching — stays in
 * the client leaf behind Suspense. No data fetching moved to the server yet.
 */

import { Suspense } from 'react'
import { FavoritesPageSkeleton } from '@/app/components/ui/PageSkeleton'
import FavoritesPageClient from './FavoritesPageClient'

export default function FavoritesPage() {
  return (
    <Suspense fallback={<FavoritesPageSkeleton />}>
      <FavoritesPageClient />
    </Suspense>
  )
}
