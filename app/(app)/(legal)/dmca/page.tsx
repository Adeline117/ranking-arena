/**
 * Server shell for /dmca (SSR conversion batch 4 — legal/static content).
 * Body is client only for useLanguage; shell streams immediately.
 */

import { Suspense } from 'react'
import { CenteredMessageSkeleton } from '@/app/components/ui/PageSkeleton'
import DmcaPageClient from './DmcaPageClient'

export default function DmcaPage() {
  return (
    <Suspense fallback={<CenteredMessageSkeleton />}>
      <DmcaPageClient />
    </Suspense>
  )
}
