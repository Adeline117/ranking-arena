/**
 * Server shell for /disclaimer (SSR conversion batch 4 — legal/static content).
 * Body is client only for useLanguage; shell streams immediately.
 */

import { Suspense } from 'react'
import { CenteredMessageSkeleton } from '@/app/components/ui/PageSkeleton'
import DisclaimerPageClient from './DisclaimerPageClient'

export default function DisclaimerPage() {
  return (
    <Suspense fallback={<CenteredMessageSkeleton />}>
      <DisclaimerPageClient />
    </Suspense>
  )
}
