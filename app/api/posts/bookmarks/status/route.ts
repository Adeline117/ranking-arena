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
import { filterServiceReadablePostRows } from '@/lib/data/service-post-audience'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

// 批量检查多个帖子的收藏状态
export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // CSRF validation
    const cookieToken = request.cookies.get(CSRF_COOKIE_NAME)?.value
    const headerToken = request.headers.get(CSRF_HEADER_NAME) ?? undefined
    if (!validateCsrfToken(cookieToken, headerToken)) {
      return NextResponse.json({ error: 'CSRF validation failed' }, { status: 403 })
    }

    const supabase = getSupabaseAdmin()

    const body: unknown = await request.json()
    const postIds =
      body && typeof body === 'object' && !Array.isArray(body) && 'postIds' in body
        ? (body as { postIds?: unknown }).postIds
        : null

    if (!Array.isArray(postIds) || postIds.length === 0) {
      return NextResponse.json({ bookmarks: {} })
    }

    // 限制一次最多查询 100 个帖子
    const limitedPostIds = [
      ...new Set(postIds.slice(0, 100).filter((id): id is string => typeof id === 'string')),
    ]
    const validPostIds = limitedPostIds.filter((id) => UUID_RE.test(id))
    const readableRows = await filterServiceReadablePostRows(
      supabase,
      validPostIds.map((id) => ({ id })),
      user.id
    )
    const readablePostIds = readableRows.map(({ id }) => id)

    const bookmarkMap: Record<string, boolean> = {}
    limitedPostIds.forEach((id) => {
      bookmarkMap[id] = false
    })

    if (readablePostIds.length === 0) {
      return NextResponse.json({ bookmarks: bookmarkMap })
    }

    // 批量查询所有收藏记录
    const { data: bookmarks, error: queryError } = await supabase
      .from('post_bookmarks')
      .select('post_id')
      .eq('user_id', user.id)
      .in('post_id', readablePostIds)

    if (queryError) {
      apiLogger.error('Error querying bookmarks:', queryError)
      return NextResponse.json({ bookmarks: {} })
    }

    bookmarks?.forEach((b) => {
      bookmarkMap[b.post_id] = true
    })

    return NextResponse.json({ bookmarks: bookmarkMap })
  } catch (error: unknown) {
    apiLogger.error('Error checking batch bookmarks:', error)
    return NextResponse.json({ bookmarks: {} })
  }
}
