'use client'

import { features } from '@/lib/features'
import { redirect } from 'next/navigation'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { supabase } from '@/lib/supabase/client'
import { PostFeedPageSkeleton } from '@/app/components/ui/PageSkeleton'
import ErrorState from '@/app/components/ui/ErrorState'

/**
 * /my-posts — Redirects to user's profile page.
 * When social is re-enabled, posts will be a tab on /u/[handle].
 * Original code preserved in git history.
 */
export default function MyPostsPage() {
  if (!features.social) redirect('/')

  const router = useRouter()
  const {
    authChecked,
    loading: authLoading,
    sessionGeneration,
    userId,
    viewerKey,
  } = useAuthSession()
  const [loadFailed, setLoadFailed] = useState(false)
  const [retryGeneration, setRetryGeneration] = useState(0)

  useEffect(() => {
    if (!authChecked || authLoading) return

    if (!userId) {
      router.replace('/login?redirect=/my-posts')
      return
    }

    let cancelled = false
    setLoadFailed(false)

    // Fetch the current viewer's handle and redirect to their profile. Keep the
    // request tied to this auth generation so a late response from a previous
    // account can never route the next viewer.
    const redirectToProfile = async () => {
      const { data, error } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', userId)
        .maybeSingle()

      if (cancelled) return
      if (error) {
        setLoadFailed(true)
        return
      }

      if (data?.handle) {
        router.replace(`/u/${encodeURIComponent(data.handle)}`)
      } else {
        router.replace('/settings?section=profile')
      }
    }
    void redirectToProfile()

    return () => {
      cancelled = true
    }
  }, [authChecked, authLoading, retryGeneration, router, sessionGeneration, userId, viewerKey])

  if (loadFailed) {
    return (
      <ErrorState
        title="Could not load your profile"
        description="Your session is still active. Retry the profile lookup to open your posts."
        retry={() => setRetryGeneration((generation) => generation + 1)}
      />
    )
  }

  return <PostFeedPageSkeleton />
}
