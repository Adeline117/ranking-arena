'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase/client'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box } from '@/app/components/base'
import { ListSkeleton } from '@/app/components/ui/Skeleton'

/**
 * Dashboard page - redirects to user profile.
 * The dashboard has been deprecated in favor of the user profile page (/u/[handle])
 * which already provides all the same functionality (stats, activity, navigation).
 * This route is kept to avoid breaking existing bookmarks/links.
 */
export default function DashboardPage() {
  const router = useRouter()
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(async ({ data }) => {
      setEmail(data.user?.email ?? null)

      if (!data.user?.id) {
        router.replace('/login')
        return
      }

      // Fetch user handle to redirect to their profile
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('handle')
        .eq('id', data.user.id)
        .maybeSingle()

      if (profile?.handle) {
        router.replace(`/u/${encodeURIComponent(profile.handle)}`)
      } else {
        // No handle set yet, go to settings to create one
        router.replace('/settings')
      }
    }).catch(() => {
      router.replace('/login')
    })
  }, [router])

  return (
    <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary, color: tokens.colors.text.primary }}>
      <TopNav email={email} />
      <Box style={{ maxWidth: 900, margin: '0 auto', padding: '40px 16px' }}>
        <ListSkeleton count={3} gap={16} />
      </Box>
    </Box>
  )
}
