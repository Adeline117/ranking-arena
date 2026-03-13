'use client'

import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthSession } from '@/lib/hooks/useAuthSession'
import { supabase } from '@/lib/supabase/client'

/**
 * /my-posts — Redirects to user's profile page.
 * When social is re-enabled, posts will be a tab on /u/[handle].
 * Original code preserved in git history.
 */
export default function MyPostsPage() {
  if (!features.social) notFound()

  const router = useRouter()
  const { userId } = useAuthSession()

  useEffect(() => {
    if (!userId) {
      router.replace('/login?redirect=/my-posts')
      return
    }

    // Fetch user handle and redirect to their profile
    const redirect = async () => {
      const { data } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', userId)
        .maybeSingle()

      if (data?.handle) {
        router.replace(`/u/${data.handle}`)
      } else {
        router.replace('/')
      }
    }
    redirect()
  }, [userId, router])

  return null
}
