import { features } from '@/lib/features'
import { notFound } from 'next/navigation'
import { Suspense } from 'react'
import { unstable_cache } from 'next/cache'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { tokens } from '@/lib/design-tokens'
import TopNav from '@/app/components/layout/TopNav'
import { Box } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import HotContent from './HotContent'
import type { Post } from './types'

export const revalidate = 300 // ISR: 5 min

// Prefetch hot posts server-side to avoid client waterfall
const getHotPosts = unstable_cache(
  async (): Promise<Post[]> => {
    try {
      const supabase = getSupabaseAdmin()
      const { data } = await supabase
        .from('posts')
        .select(`
          id, title, content, created_at,
          like_count, comment_count, view_count, hot_score, dislike_count,
          group_id,
          groups:group_id(name, name_en),
          user_profiles:author_id(handle, avatar_url, display_name)
        `)
        .order('hot_score', { ascending: false })
        .limit(30)

      if (!data || data.length === 0) return []

      return data.map((post: Record<string, unknown>) => {
        const groups = post.groups as Record<string, unknown> | null
        const author = post.user_profiles as Record<string, unknown> | null
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
          title: (post.title as string) || '',
          author: (author?.handle as string) || 'user',
          author_handle: (author?.handle as string) || undefined,
          time: timeStr,
          body: (post.content as string) || '',
          comments: (post.comment_count as number) || 0,
          likes: (post.like_count as number) || 0,
          dislikes: (post.dislike_count as number) || 0,
          hotScore,
          views: (post.view_count as number) || 0,
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
  if (!features.social) notFound()

  const initialPosts = await getHotPosts()

  return (
    <Suspense fallback={
      <Box style={{ minHeight: '100vh', background: 'var(--color-bg-primary)', color: 'var(--color-text-primary)' }}>
        <TopNav email={null} />
        <Box style={{ maxWidth: 1200, margin: '0 auto', padding: tokens.spacing[6] }}>
          <RankingSkeleton />
        </Box>
      </Box>
    }>
      <HotContent initialPosts={initialPosts} />
    </Suspense>
  )
}
