/**
 * 批量检查帖子收藏状态 API
 * POST /api/posts/bookmarks/status - 检查多个帖子的收藏状态
 */

import { NextRequest, NextResponse } from 'next/server'
import { apiLogger } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { filterServiceReadablePostRowsStrict } from '@/lib/data/service-post-audience'
import { z } from 'zod'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const BookmarkStatusRequestSchema = z
  .object({
    postIds: z.array(z.string().uuid()).min(1).max(100),
    request_id: z.string().regex(/^[0-9a-f]{32}$/),
  })
  .strict()
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function privateNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

// 批量检查多个帖子的收藏状态
async function readBookmarkStatus(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthUser(request)
    if (!user || !UUID_RE.test(user.id)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const supabase = getSupabaseAdmin()

    let body: unknown
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = BookmarkStatusRequestSchema.safeParse(body)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid bookmark status request' }, { status: 400 })
    }

    // Enforce the raw 100-item limit before canonical deduplication, then bind
    // the acknowledgement to the exact unique sequence the server evaluated.
    const postIds = [...new Set(parsedBody.data.postIds.map((postId) => postId.toLowerCase()))]
    const readableRows = await filterServiceReadablePostRowsStrict(
      supabase,
      postIds.map((id) => ({ id })),
      user.id
    )
    if (
      !Array.isArray(readableRows) ||
      readableRows.some(
        (row) =>
          !isRecord(row) ||
          !hasExactKeys(row, ['id']) ||
          typeof row.id !== 'string' ||
          !postIds.includes(row.id.toLowerCase())
      )
    ) {
      throw new Error('Bookmark audience authority returned an invalid result')
    }
    const readablePostIds = [...new Set(readableRows.map(({ id }) => id.toLowerCase()))]

    const bookmarkMap: Record<string, boolean> = {}
    postIds.forEach((id) => {
      bookmarkMap[id] = false
    })

    if (readablePostIds.length === 0) {
      return NextResponse.json({
        actor_id: user.id.toLowerCase(),
        request_id: parsedBody.data.request_id,
        operation: 'status',
        post_ids: postIds,
        bookmarks: bookmarkMap,
      })
    }

    // 批量查询所有收藏记录
    const { data: bookmarks, error: queryError } = await supabase
      .from('post_bookmarks')
      .select('post_id')
      .eq('user_id', user.id)
      .in('post_id', readablePostIds)

    if (queryError) {
      apiLogger.error('Error querying bookmarks:', queryError)
      return NextResponse.json({ error: 'Failed to load bookmark status' }, { status: 500 })
    }
    if (!Array.isArray(bookmarks)) {
      apiLogger.error('Bookmark status query returned an invalid result')
      return NextResponse.json({ error: 'Failed to load bookmark status' }, { status: 500 })
    }

    const seenBookmarkIds = new Set<string>()
    for (const bookmark of bookmarks) {
      if (
        !isRecord(bookmark) ||
        !hasExactKeys(bookmark, ['post_id']) ||
        typeof bookmark.post_id !== 'string' ||
        !UUID_RE.test(bookmark.post_id)
      ) {
        throw new Error('Bookmark status query returned an invalid row')
      }
      const bookmarkPostId = bookmark.post_id.toLowerCase()
      if (!readablePostIds.includes(bookmarkPostId) || seenBookmarkIds.has(bookmarkPostId)) {
        throw new Error('Bookmark status query returned a mismatched row')
      }
      seenBookmarkIds.add(bookmarkPostId)
      bookmarkMap[bookmarkPostId] = true
    }

    return NextResponse.json({
      actor_id: user.id.toLowerCase(),
      request_id: parsedBody.data.request_id,
      operation: 'status',
      post_ids: postIds,
      bookmarks: bookmarkMap,
    })
  } catch (error: unknown) {
    apiLogger.error('Error checking batch bookmarks:', error)
    return NextResponse.json({ error: 'Failed to load bookmark status' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return privateNoStore(guard)

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.authenticated)
  if (rateLimitResp) return privateNoStore(rateLimitResp)

  return privateNoStore(await readBookmarkStatus(request))
}
