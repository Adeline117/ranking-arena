/**
 * Trending Discussions API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'

export const runtime = 'edge'

export const GET = withPublic(
  async ({ supabase }) => {
    const data = await getOrSetWithLock(
      'sidebar:trending-discussions',
      async () => {
        const { data: postsData } = await supabase
          .from('posts')
          .select('id, title, content, author_handle, comment_count, like_count, view_count, hot_score, created_at, group_id')
          .eq('status', 'active')
          .order('hot_score', { ascending: false })
          .limit(8)

        const posts = postsData || []

        // Fetch group names
        if (posts.length > 0) {
          const groupIds = posts.map(p => p.group_id).filter(Boolean) as string[]
          if (groupIds.length > 0) {
            const { data: groupData } = await supabase
              .from('groups')
              .select('id, name')
              .in('id', groupIds)
            const groupMap = new Map((groupData || []).map(g => [g.id, g.name]))
            posts.forEach(p => {
              ;(p as Record<string, unknown>).group_name = p.group_id ? groupMap.get(p.group_id) || null : null
            })
          }
        }

        return { posts }
      },
      { ttl: 180, lockTtl: 10 } // Cache 3 minutes
    )

    const response = NextResponse.json(data)
    response.headers.set('Cache-Control', 'public, s-maxage=180, stale-while-revalidate=360')
    return response
  },
  { name: 'sidebar-trending', rateLimit: 'read' }
)
