/**
 * Server shell for /inbox (Wave-3 SSR conversion).
 *
 * The shell streams immediately (metadata lives in layout.tsx); the
 * interactive body — auth session, notifications/messages tabs — stays in
 * the client leaf behind Suspense. No data fetching moved to the server yet.
 */

import { Suspense } from 'react'
import { NotificationsPageSkeleton } from '@/app/components/ui/PageSkeleton'
import InboxPageClient from './InboxPageClient'

export default function InboxPage() {
  return (
    <Suspense fallback={<NotificationsPageSkeleton />}>
      <InboxPageClient />
    </Suspense>
  )
}
