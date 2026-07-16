import type { Metadata } from 'next'
import { features } from '@/lib/features'
import { Suspense } from 'react'
import { unstable_cache } from 'next/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tokens } from '@/lib/design-tokens'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import SocialComingSoonPage from '@/app/components/ui/SocialComingSoonPage'
import HotContent from './HotContent'
import { BASE_URL } from '@/lib/constants/urls'
import { normalizePostTitle } from '@/lib/utils/post-display'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

export const metadata: Metadata = {
  title: 'Hot Posts & Trending Discussions',
  description:
    'Trending crypto trading discussions, market insights, and top posts from the Arena community.',
  alternates: { canonical: `${BASE_URL}/hot` },
  openGraph: {
    title: 'Hot Posts & Trending Discussions',
    description:
      'Trending crypto trading discussions, market insights, and top posts from the Arena community.',
    url: `${BASE_URL}/hot`,
    images: [{ url: `${BASE_URL}/api/og`, width: 1200, height: 630 }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Hot Posts & Trending',
    creator: '@arenafi',
  },
}
import type { Post } from './types'

export const revalidate = 300 // ISR: 5 min

// Prefetch hot posts server-side to avoid client waterfall
const getHotPosts = unstable_cache(
  async (): Promise<Post[]> => {
    try {
      const supabase = getSupabaseAdmin()
      // NOTE: posts.author_id references auth.users (not public.user_profiles),
      // so a PostgREST embed fails with PGRST200. Two-step query: fetch posts,
      // then look up author profiles by id and merge.
      const { data, error } = await supabase
        .from('posts')
        .select(
          `
          id, title, content, created_at,
          like_count, comment_count, view_count, hot_score, dislike_count,
          group_id, author_id, original_post_id, visibility, status, deleted_at,
          groups:group_id(name, name_en)
        `
        )
        .neq('status', 'deleted')
        .is('deleted_at', null)
        .eq('visibility', 'public')
        .is('group_id', null)
        .order('hot_score', { ascending: false })
        .limit(30)

      if (error || !data || data.length === 0) return []

      const readablePosts = await filterServiceReadablePostRows(supabase, data, null)
      if (readablePosts.length === 0) return []

      const authorIds = [
        ...new Set(
          readablePosts.map((p: Record<string, unknown>) => p.author_id as string).filter(Boolean)
        ),
      ]
      // (user_profiles has no display_name column — selecting it 400s with 42703)
      const { data: authorProfiles } = authorIds.length
        ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', authorIds)
        : { data: null }
      const profileById = new Map(
        (authorProfiles || []).map((p: Record<string, unknown>) => [p.id as string, p])
      )

      return readablePosts.map((post: Record<string, unknown>) => {
        const groups = post.groups as Record<string, unknown> | null
        const author = profileById.get(post.author_id as string) ?? null
        const createdAt = post.created_at as string
        const hotScore = (post.hot_score as number) || 0

        // Compute relative time string (simple server-side version)
        const diffMs = Date.now() - new Date(createdAt).getTime()
        const hours = Math.floor(diffMs / 3600000)
        const days = Math.floor(hours / 24)
        const timeStr = days > 0 ? `${days}d` : hours > 0 ? `${hours}h` : '<1h'

        return {
          id: post.id as string,
          group: (groups?.name as string) || '',
          group_en: (groups?.name_en as string) || undefined,
          group_id: (post.group_id as string) || undefined,
          title: normalizePostTitle(post.title as string),
          author: (author?.handle as string) || 'user',
          author_handle: (author?.handle as string) || undefined,
          author_avatar_url: (author?.avatar_url as string) || null,
          author_display_name: (author?.display_name as string) || null,
          time: timeStr,
          body: (post.content as string) || '',
          content: (post.content as string) || '',
          comments: (post.comment_count as number) || 0,
          likes: (post.like_count as number) || 0,
          like_count: (post.like_count as number) || 0,
          comment_count: (post.comment_count as number) || 0,
          dislike_count: (post.dislike_count as number) || 0,
          dislikes: (post.dislike_count as number) || 0,
          hotScore,
          hot_score: hotScore,
          views: (post.view_count as number) || 0,
          view_count: (post.view_count as number) || 0,
          created_at: createdAt,
          user_reaction: null,
        }
      })
    } catch {
      return []
    }
  },
  ['hot-posts'],
  { revalidate: 300, tags: ['posts'] }
)

export default async function HotPage() {
  if (!features.social) return <SocialComingSoonPage />

  const initialPosts = await getHotPosts()

  return (
    <Suspense
      fallback={
        <Box
          style={{
            minHeight: '100vh',
            background: 'var(--color-bg-primary)',
            color: 'var(--color-text-primary)',
          }}
        >
          <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
            <RankingSkeleton />
          </Box>
        </Box>
      }
    >
      <HotContent initialPosts={initialPosts} />
    </Suspense>
  )
}
