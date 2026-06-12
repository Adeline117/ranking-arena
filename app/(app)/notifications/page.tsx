/**
 * Server shell for /notifications (Wave-3 SSR conversion).
 * Metadata lives in layout.tsx; auth + polling stay in the client leaf.
 */

import { Suspense } from 'react'
import { NotificationsPageSkeleton } from '@/app/components/ui/PageSkeleton'
import NotificationsPageClient from './NotificationsPageClient'

export default function NotificationsPage() {
  return (
    <Suspense fallback={<NotificationsPageSkeleton />}>
      <NotificationsPageClient />
    </Suspense>
  )
}
