/**
 * Server shell for /help (SSR conversion batch 3).
 * Interactive body stays in the client leaf behind Suspense.
 */

import { Suspense } from 'react'
import { HelpPageSkeleton } from '@/app/components/ui/PageSkeleton'
import HelpPageClient from './HelpPageClient'

export default function HelpPage() {
  return (
    <Suspense fallback={<HelpPageSkeleton />}>
      <HelpPageClient />
    </Suspense>
  )
}
