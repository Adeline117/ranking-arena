/**
 * Server shell for /following (Wave-3 SSR conversion).
 * Metadata lives in layout.tsx; auth + list logic stay in the client leaf.
 */

import { Suspense } from 'react'
import { PostFeedPageSkeleton } from '@/app/components/ui/PageSkeleton'
import FollowingPageClient from './FollowingPageClient'

export default function FollowingPage() {
  return (
    <Suspense fallback={<PostFeedPageSkeleton />}>
      <FollowingPageClient />
    </Suspense>
  )
}
