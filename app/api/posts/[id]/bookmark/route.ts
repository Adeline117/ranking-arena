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
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'
import { validateBookmarkFolderSaveAck } from '@/lib/bookmarks/folder-save'

const ToggleBookmarkSchema = z
  .object({
    folder_id: z.string().uuid().optional().nullable(),
  })
  .strict()
const RemoveBookmarkSchema = z
  .object({
    action: z.literal('remove'),
    bookmark_id: z.string().uuid(),
    folder_id: z.string().uuid(),
  })
  .strict()
// Toggle remains body-optional for existing callers. Folder-detail removal is
// an explicit identity-bound command and can never fall through to toggle.
const BookmarkSchema = z.union([RemoveBookmarkSchema, ToggleBookmarkSchema]).optional()
const PostIdSchema = z.string().uuid()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type RouteContext = { params: Promise<{ id: string }> }

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function sameUUID(value: unknown, expected: string): boolean {
  return (
    typeof value === 'string' &&
    UUID_PATTERN.test(value) &&
    value.toLowerCase() === expected.toLowerCase()
  )
}

function parseBookmarkRemovalAck(
  value: unknown,
  expected: { userId: string; postId: string; bookmarkId: string; folderId: string }
) {
  if (!isRecord(value)) return null
  if (
    hasExactKeys(value, ['status']) &&
    typeof value.status === 'string' &&
    ['invalid', 'account_inactive', 'folder_not_found', 'conflict'].includes(value.status)
  ) {
    return {
      status: value.status as 'invalid' | 'account_inactive' | 'folder_not_found' | 'conflict',
    }
  }
  if (
    !hasExactKeys(value, [
      'bookmark_count',
      'bookmark_id',
      'bookmarked',
      'folder_id',
      'post_id',
      'status',
      'user_id',
    ]) ||
    (value.status !== 'removed' && value.status !== 'already_removed') ||
    !sameUUID(value.user_id, expected.userId) ||
    !sameUUID(value.post_id, expected.postId) ||
    !sameUUID(value.bookmark_id, expected.bookmarkId) ||
    !sameUUID(value.folder_id, expected.folderId) ||
    value.bookmarked !== false ||
    !Number.isSafeInteger(value.bookmark_count) ||
    Number(value.bookmark_count) < 0
  ) {
    return null
  }
  return {
    status: value.status,
    bookmarkCount: value.bookmark_count as number,
  }
}

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
      let input: z.infer<typeof BookmarkSchema>
      try {
        const body = req.body === null ? undefined : await req.json()
        const parsed = BookmarkSchema.safeParse(body)
        if (!parsed.success) {
          return NextResponse.json(
            { error: 'Invalid input', details: parsed.error.flatten() },
            { status: 400 }
          )
        }
        input = parsed.data
      } catch {
        return NextResponse.json({ error: 'Invalid input' }, { status: 400 })
      }

      if (input && 'action' in input && input.action === 'remove') {
        const userSupabase = createUserScopedServerClient(req)
        const { data, error } = await userSupabase.rpc('remove_post_bookmark_from_folder_atomic', {
          p_post_id: postId.data,
          p_bookmark_id: input.bookmark_id,
          p_folder_id: input.folder_id,
        })
        if (error) {
          apiLogger.error('Atomic bookmark removal failed:', error)
          return NextResponse.json({ error: 'Bookmark removal failed' }, { status: 500 })
        }
        const result = parseBookmarkRemovalAck(data, {
          userId: user.id,
          postId: postId.data,
          bookmarkId: input.bookmark_id,
          folderId: input.folder_id,
        })
        if (!result) {
          return NextResponse.json({ error: 'Bookmark removal failed' }, { status: 500 })
        }
        if (result.status === 'invalid') {
          return NextResponse.json({ error: 'Invalid bookmark removal request' }, { status: 400 })
        }
        if (result.status === 'account_inactive') {
          return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
        }
        if (result.status === 'folder_not_found') {
          return NextResponse.json({ error: 'Bookmark folder not found' }, { status: 404 })
        }
        if (result.status === 'conflict') {
          return NextResponse.json(
            { error: 'Bookmark changed since this folder was loaded' },
            { status: 409 }
          )
        }

        return NextResponse.json({
          action: 'removed',
          bookmarked: false,
          bookmark_count: result.bookmarkCount,
          bookmark_id: input.bookmark_id.toLowerCase(),
          folder_id: input.folder_id.toLowerCase(),
          already_removed: result.status === 'already_removed',
        })
      }

      if (input?.folder_id) {
        const userSupabase = createUserScopedServerClient(req)
        const { data, error } = await userSupabase.rpc('save_post_bookmark_to_folder_atomic', {
          p_post_id: postId.data,
          p_folder_id: input.folder_id,
        })
        if (error) {
          apiLogger.error('Atomic bookmark folder save failed:', error)
          return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
        }

        let result
        try {
          result = validateBookmarkFolderSaveAck(data, {
            userId: user.id,
            postId: postId.data,
            folderId: input.folder_id,
          })
        } catch (error) {
          apiLogger.error('Atomic bookmark folder save acknowledgement failed:', error)
          return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
        }

        if (result.status === 'invalid') {
          return NextResponse.json({ error: 'Invalid bookmark request' }, { status: 400 })
        }
        if (result.status === 'account_inactive') {
          return NextResponse.json({ error: 'Account is inactive' }, { status: 403 })
        }
        if (result.status === 'post_not_found') {
          return NextResponse.json({ error: 'Post not found' }, { status: 404 })
        }
        if (result.status === 'folder_not_found') {
          return NextResponse.json({ error: 'Bookmark folder not found' }, { status: 404 })
        }

        return NextResponse.json(result)
      }

      const folder_id = input?.folder_id ?? null

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
