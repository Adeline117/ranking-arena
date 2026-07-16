/**
 * 帖子收藏 API
 * POST /api/posts/[id]/bookmark - 收藏/取消收藏
 * GET /api/posts/[id]/bookmark - 检查是否已收藏
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth, withApiMiddleware } from '@/lib/api/middleware'
import { apiLogger } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'

// Zod schema for POST /api/posts/[id]/bookmark (body is optional)
const BookmarkSchema = z
  .object({
    folder_id: z.string().uuid().optional().nullable(),
  })
  .optional()
const PostIdSchema = z.string().uuid()

type RouteContext = { params: Promise<{ id: string }> }

// 检查用户是否已收藏 (auth optional — returns { bookmarked: false } when unauthenticated)
export async function GET(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id } = await context.params
  const postId = PostIdSchema.safeParse(id)
  if (!postId.success) {
    return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withApiMiddleware(
    async ({ user, supabase }) => {
      if (!user) {
        return NextResponse.json({ bookmarked: false })
      }

      if (!(await canServiceActorReadPost(supabase, postId.data, user.id))) {
        return NextResponse.json({ bookmarked: false })
      }

      const { data: bookmark } = await supabase
        .from('post_bookmarks')
        .select('id')
        .eq('post_id', postId.data)
        .eq('user_id', user.id)
        .maybeSingle()

      return NextResponse.json({ bookmarked: !!bookmark })
    },
    { name: 'posts-bookmark-check', rateLimit: 'authenticated', readsAuth: true }
  )

  return handler(request)
}

// 收藏/取消收藏
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id } = await context.params
  const postId = PostIdSchema.safeParse(id)
  if (!postId.success) {
    return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      // 获取请求体中的 folder_id（提前获取，用于判断是移动收藏夹还是取消收藏）
      let folder_id: string | null = null
      try {
        const body = await req.json()
        const parsed = BookmarkSchema.safeParse(body)
        if (parsed.success && parsed.data?.folder_id) {
          folder_id = parsed.data.folder_id
        } else if (!parsed.success) {
          return NextResponse.json(
            { error: 'Invalid input', details: parsed.error.flatten() },
            { status: 400 }
          )
        }
      } catch {
        // Intentionally swallowed: no request body or invalid JSON, proceed with default folder / toggle bookmark
      }

      const { data, error } = await supabase.rpc('toggle_post_bookmark_atomic', {
        p_actor_id: user.id,
        p_post_id: postId.data,
        p_folder_id: folder_id,
      })

      if (error) {
        apiLogger.error('Atomic bookmark toggle failed:', error)
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }

      const result = data as Record<string, unknown>
      if (result.status === 'not_found') {
        return NextResponse.json({ error: 'Post not found' }, { status: 404 })
      }
      if (result.status === 'invalid_folder') {
        return NextResponse.json({ error: 'Bookmark folder not found' }, { status: 404 })
      }
      if (result.status === 'invalid') {
        return NextResponse.json({ error: 'Invalid bookmark request' }, { status: 400 })
      }

      const action = result.action
      const validAction = action === 'added' || action === 'removed' || action === 'moved'
      const expectedBookmarked = action !== 'removed'
      const validFolder =
        (action === 'removed' && result.folder_id === null) ||
        ((action === 'added' || action === 'moved') &&
          typeof result.folder_id === 'string' &&
          PostIdSchema.safeParse(result.folder_id).success)
      if (
        result.status !== action ||
        !validAction ||
        result.bookmarked !== expectedBookmarked ||
        !Number.isSafeInteger(result.bookmark_count) ||
        (result.bookmark_count as number) < 0 ||
        !validFolder
      ) {
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }

      return NextResponse.json({
        action,
        bookmarked: result.bookmarked,
        bookmark_count: result.bookmark_count,
        folder_id: result.folder_id,
      })
    },
    { name: 'posts-bookmark', rateLimit: 'write' }
  )

  return handler(request)
}
