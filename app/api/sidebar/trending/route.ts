/**
 * Trending Discussions API for sidebar widget
 * Cached via Redis to avoid direct Supabase calls from client
 */

import { NextResponse } from 'next/server'
import { withPublic } from '@/lib/api/middleware'
import { getOrSetWithLock } from '@/lib/cache'
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

interface TrendingPostCandidate {
  id: string
  title: string | null
  content: string | null
  author_handle: string | null
  comment_count: number | null
  like_count: number | null
  view_count: number | null
  hot_score: number | null
  created_at: string
  group_id: string | null
}

export const runtime = 'edge'

export const GET = withPublic(
  async ({ supabase }) => {
    const candidates = await getOrSetWithLock<TrendingPostCandidate[]>(
      'sidebar:trending-discussions:v2:candidates',
      async () => {
        const { data: postsData } = await supabase
          .from('posts')
          .select(
            'id, title, content, author_handle, comment_count, like_count, view_count, hot_score, created_at, group_id'
          )
          .eq('status', 'active')
          .order('hot_score', { ascending: false })
          .limit(32)

        return (postsData as TrendingPostCandidate[] | null) ?? []
      },
      { ttl: 180, lockTtl: 10 } // Cache 3 minutes
    )

    // The service client bypasses RLS. Redis therefore stores candidates only;
    // every hit is re-authorized for the anonymous sidebar audience.
    const readableCandidates = await filterServiceReadablePostRows(supabase, candidates, null)
    const groupIds = [
      ...new Set(
        readableCandidates
          .map((post) => post.group_id)
          .filter((groupId): groupId is string => typeof groupId === 'string')
      ),
    ]
    let groupMap = new Map<string, string>()
    if (groupIds.length > 0) {
      const { data: groupData, error: groupError } = await supabase
        .from('groups')
        .select('id, name')
        .in('id', groupIds)
        .is('dissolved_at', null)
      if (!groupError) {
        groupMap = new Map((groupData ?? []).map((group) => [group.id, group.name]))
      }
    }

    const posts = readableCandidates
      .filter((post) => post.group_id === null || groupMap.has(post.group_id))
      .slice(0, 8)
      .map((post) => ({
        ...post,
        ...(post.group_id ? { group_name: groupMap.get(post.group_id) ?? null } : {}),
      }))

    const response = NextResponse.json({ posts })
    response.headers.set('Cache-Control', 'private, no-store, max-age=0')
    response.headers.set('CDN-Cache-Control', 'no-store')
    response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
    return response
  },
  { name: 'sidebar-trending', rateLimit: 'read' }
)
