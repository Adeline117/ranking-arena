import type { Metadata } from 'next'
import { features } from '@/lib/features'
import { Suspense } from 'react'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { getPosts } from '@/lib/data/posts'
import { logger } from '@/lib/logger'
import { unstable_cache } from 'next/cache'
import GroupsFeedPage from '@/app/components/groups/GroupsFeedPage'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import SocialComingSoonPage from '@/app/components/ui/SocialComingSoonPage'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { BASE_URL } from '@/lib/constants/urls'

export const metadata: Metadata = {
  title: 'Trading Groups & Community',
  description:
    'Join crypto trading groups, share insights, and discuss strategies with ranked traders on Arena.',
  alternates: { canonical: `${BASE_URL}/groups` },
  openGraph: {
    title: 'Trading Groups & Community',
    description:
      'Join crypto trading groups, share insights, and discuss strategies with ranked traders.',
    url: `${BASE_URL}/groups`,
    images: [{ url: `${BASE_URL}/api/og`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Trading Groups & Community',
    description:
      'Join crypto trading groups, share insights, and discuss strategies with ranked traders.',
    creator: '@arenafi',
  },
}

export const revalidate = 300 // ISR: 5 min

// Prefetch recommended posts server-side to avoid client waterfall
const getRecommendedPosts = unstable_cache(
  async () => {
    try {
      const supabase = getSupabaseAdmin()
      // Reuse the canonical data-layer mapping (same path as /api/posts) so the
      // SSR payload carries the flat author_* fields that PostListItem /
      // MasonryPostCard read (author_handle, author_avatar_url, author_is_pro).
      // A previous hand-rolled query merged authors as a nested `user_profiles`
      // object, which the renderers never read → every author showed as
      // "Deleted user". No viewer_id here (anonymous SSR) → public posts only.
      return await getPosts(supabase, {
        limit: 10,
        sort_by: 'hot_score',
        sort_order: 'desc',
      })
    } catch (error) {
      logger.error('[groups] getRecommendedPosts failed', error)
      return []
    }
  },
  ['groups-recommended-posts'],
  { revalidate: 300, tags: ['posts'] }
)

export async function loadRecommendedGroupsSSR() {
  const supabase = getSupabaseAdmin()
  const { data, error } = await supabase
    .from('groups')
    .select('id, name, name_en, avatar_url, member_count, description')
    .order('member_count', { ascending: false })
    .limit(8)
  if (error) throw new Error(error.message)
  return data || []
}

const getRecommendedGroups = unstable_cache(
  loadRecommendedGroupsSSR,
  // Do not reuse empty values cached by the former fail-soft loader.
  ['groups-recommended-groups-v2'],
  { revalidate: 600, tags: ['groups'] }
)

export default async function GroupsPage() {
  if (!features.social) return <SocialComingSoonPage />

  // Parallel server-side data fetching
  const [initialPosts, recommendedGroupsResult] = await Promise.all([
    getRecommendedPosts(),
    getRecommendedGroups()
      .then((groups) => ({ groups, status: 'success' as const }))
      .catch((error) => {
        logger.error('[groups] getRecommendedGroups failed', error)
        return { groups: [], status: 'error' as const }
      }),
  ])

  return (
    <Suspense
      fallback={
        <Box style={{ minHeight: '100vh', background: tokens.colors.bg.primary }}>
          <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
            <RankingSkeleton />
          </Box>
        </Box>
      }
    >
      <GroupsFeedPage
        initialPosts={initialPosts}
        initialGroups={recommendedGroupsResult.groups}
        initialGroupsStatus={recommendedGroupsResult.status}
      />
    </Suspense>
  )
}
