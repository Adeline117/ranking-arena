/**
 * Server shell for /about (SSR conversion batch 4 — legal/static content).
 * Body is client only for useLanguage; shell streams immediately.
 */

import { Suspense } from 'react'
import { CenteredMessageSkeleton } from '@/app/components/ui/PageSkeleton'
import AboutPageClient from './AboutPageClient'

export default function AboutPage() {
  return (
    <Suspense fallback={<CenteredMessageSkeleton />}>
      <AboutPageClient />
    </Suspense>
  )
}
