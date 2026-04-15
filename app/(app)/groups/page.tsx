import type { Metadata } from 'next'
import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { unstable_cache } from 'next/cache'
import GroupsFeedPage from '@/app/components/groups/GroupsFeedPage'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Trading Groups & Community',
  description: 'Join crypto trading groups, share insights, and discuss strategies with ranked traders on Arena.',
  alternates: { canonical: `${BASE_URL}/groups` },
  openGraph: {
    title: 'Trading Groups & Community',
    description: 'Join crypto trading groups, share insights, and discuss strategies with ranked traders.',
    url: `${BASE_URL}/groups`,
    images: [{ url: `${BASE_URL}/api/og`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Groups & Community',
    description: 'Join crypto trading groups, share insights, and discuss strategies with ranked traders.',
    creator: '@arenafi',
  },
}

export const revalidate = 300 // ISR: 5 min

// Prefetch recommended posts server-side to avoid client waterfall
const getRecommendedPosts = unstable_cache(
  async () => {
    try {
      const supabase = getSupabaseAdmin()
      const { data } = await supabase
        .from('posts')
        .select('id, title, content, created_at, author_id, group_id, like_count, comment_count, hot_score, user_profiles:author_id(handle, avatar_url, display_name)')
        .order('hot_score', { ascending: false })
        .limit(10)
      return data || []
    } catch {
      return []
    }
  },
  ['groups-recommended-posts'],
  { revalidate: 300, tags: ['posts'] }
)

const getRecommendedGroups = unstable_cache(
  async () => {
    try {
      const supabase = getSupabaseAdmin()
      const { data } = await supabase
        .from('groups')
        .select('id, name, name_en, avatar_url, member_count, description')
        .order('member_count', { ascending: false })
        .limit(8)
      return data || []
    } catch {
      return []
    }
  },
  ['groups-recommended-groups'],
  { revalidate: 600, tags: ['groups'] }
)

export default async function GroupsPage() {
  if (!features.social) notFound()

  // Parallel server-side data fetching
  const [initialPosts, recommendedGroups] = await Promise.all([
    getRecommendedPosts(),
    getRecommendedGroups(),
  ])

  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <GroupsFeedPage
        initialPosts={initialPosts}
        initialGroups={recommendedGroups}
      />
    </Suspense>
  )
}
