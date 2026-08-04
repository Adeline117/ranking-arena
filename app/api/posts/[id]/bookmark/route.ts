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
import { canServiceActorReadPostStrict } from '@/lib/data/service-post-audience'
import { createUserScopedServerClient } from '@/lib/supabase/user-scoped-server'
import { validateBookmarkFolderSaveAck } from '@/lib/bookmarks/folder-save'

const ToggleBookmarkSchema = z
  .object({
    operation: z.literal('toggle'),
    request_id: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict()
const SaveBookmarkSchema = z
  .object({
    folder_id: z.string().uuid(),
  })
  .strict()
const RemoveBookmarkSchema = z
  .object({
    action: z.literal('remove'),
    bookmark_id: z.string().uuid(),
    folder_id: z.string().uuid(),
  })
  .strict()
// Folder save/removal retain their existing identity-bound contracts. The
// toggle command is explicit and request-bound so an empty or malformed body
// can never mutate state.
const BookmarkSchema = z.union([RemoveBookmarkSchema, SaveBookmarkSchema, ToggleBookmarkSchema])
const PostIdSchema = z.string().uuid()
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

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

function privateNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
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
  if (guard) return privateNoStore(guard)

  const { id } = await context.params
  const postId = PostIdSchema.safeParse(id)
  if (!postId.success) {
    return privateNoStore(NextResponse.json({ error: 'Invalid post ID' }, { status: 400 }))
  }

  const handler = withApiMiddleware(
    async ({ user, supabase }) => {
      if (!user) {
        return NextResponse.json({ bookmarked: false })
      }

      let canReadPost: boolean
      try {
        canReadPost = await canServiceActorReadPostStrict(supabase, postId.data, user.id)
      } catch (error) {
        apiLogger.error('Bookmark audience authority failed:', error)
        return NextResponse.json({ error: 'Failed to load bookmark status' }, { status: 500 })
      }
      if (!canReadPost) {
        return NextResponse.json({ bookmarked: false })
      }

      const { data: bookmark, error } = await supabase
        .from('post_bookmarks')
        .select('id')
        .eq('post_id', postId.data)
        .eq('user_id', user.id)
        .maybeSingle()

      if (
        error ||
        (bookmark !== null &&
          (!isRecord(bookmark) ||
            !hasExactKeys(bookmark, ['id']) ||
            typeof bookmark.id !== 'string' ||
            !PostIdSchema.safeParse(bookmark.id).success))
      ) {
        apiLogger.error('Bookmark status query failed:', error)
        return NextResponse.json({ error: 'Failed to load bookmark status' }, { status: 500 })
      }

      return NextResponse.json({ bookmarked: !!bookmark })
    },
    { name: 'posts-bookmark-check', rateLimit: 'authenticated', readsAuth: true }
  )

  return privateNoStore(await handler(request))
}

// 收藏/取消收藏
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return privateNoStore(guard)

  const { id } = await context.params
  const postId = PostIdSchema.safeParse(id)
  if (!postId.success) {
    return privateNoStore(NextResponse.json({ error: 'Invalid post ID' }, { status: 400 }))
  }

  const handler = withAuth(
    async ({ user, supabase, request: req }) => {
      let input: z.infer<typeof BookmarkSchema>
      try {
        const body = await req.json()
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

      if ('action' in input && input.action === 'remove') {
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

      if ('folder_id' in input) {
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

      const actorId = PostIdSchema.safeParse(user.id)
      if (!actorId.success) {
        return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
      }

      const { data, error } = await supabase.rpc('toggle_post_bookmark_atomic', {
        p_actor_id: actorId.data,
        p_post_id: postId.data,
        p_folder_id: null,
      })

      if (error) {
        apiLogger.error('Atomic bookmark toggle failed:', error)
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }
      if (!isRecord(data)) {
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }

      const result = data
      if (result.status === 'not_found') {
        if (!hasExactKeys(result, ['status'])) {
          return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
        }
        return NextResponse.json({ error: 'Post not found' }, { status: 404 })
      }
      if (result.status === 'invalid_folder') {
        if (!hasExactKeys(result, ['status'])) {
          return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
        }
        return NextResponse.json({ error: 'Bookmark folder not found' }, { status: 404 })
      }
      if (result.status === 'invalid') {
        if (!hasExactKeys(result, ['status'])) {
          return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
        }
        return NextResponse.json({ error: 'Invalid bookmark request' }, { status: 400 })
      }

      const action = result.action
      const validAction = action === 'added' || action === 'removed'
      const expectedBookmarked = action === 'added'
      const validFolder =
        (action === 'removed' && result.folder_id === null) ||
        (action === 'added' &&
          typeof result.folder_id === 'string' &&
          PostIdSchema.safeParse(result.folder_id).success)
      if (
        !hasExactKeys(result, ['action', 'bookmark_count', 'bookmarked', 'folder_id', 'status']) ||
        result.status !== action ||
        !validAction ||
        result.bookmarked !== expectedBookmarked ||
        !Number.isSafeInteger(result.bookmark_count) ||
        (result.bookmark_count as number) < 0 ||
        (action === 'added' && (result.bookmark_count as number) < 1) ||
        !validFolder
      ) {
        return NextResponse.json({ error: 'Bookmark failed' }, { status: 500 })
      }

      return NextResponse.json({
        actor_id: actorId.data.toLowerCase(),
        post_id: postId.data.toLowerCase(),
        request_id: input.request_id,
        operation: input.operation,
        action,
        bookmarked: result.bookmarked,
        bookmark_count: result.bookmark_count,
        folder_id: result.folder_id,
      })
    },
    { name: 'posts-bookmark', rateLimit: 'write' }
  )

  return privateNoStore(await handler(request))
}
