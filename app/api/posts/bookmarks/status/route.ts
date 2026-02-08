/**
 * 批量检查帖子收藏状态 API
 * POST /api/posts/bookmarks/status - 检查多个帖子的收藏状态
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { apiLogger } from '@/lib/utils/logger'
import { getAuthUser } from '@/lib/supabase/server'
import { validateCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '@/lib/utils/csrf'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 批量检查多个帖子的收藏状态
export async function POST(request: NextRequest) {
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

    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const body = await request.json()
    const postIds: string[] = body.postIds || []

    if (!Array.isArray(postIds) || postIds.length === 0) {
      return NextResponse.json({ bookmarks: {} })
    }

    // 限制一次最多查询 100 个帖子
    const limitedPostIds = postIds.slice(0, 100)

    // 批量查询所有收藏记录
    const { data: bookmarks, error: queryError } = await supabase
      .from('post_bookmarks')
      .select('post_id')
      .eq('user_id', user.id)
      .in('post_id', limitedPostIds)

    if (queryError) {
      apiLogger.error('Error querying bookmarks:', queryError)
      return NextResponse.json({ bookmarks: {} })
    }

    // 构建返回结果：{ postId: boolean }
    const bookmarkMap: Record<string, boolean> = {}
    limitedPostIds.forEach(id => {
      bookmarkMap[id] = false
    })
    bookmarks?.forEach(b => {
      bookmarkMap[b.post_id] = true
    })

    return NextResponse.json({ bookmarks: bookmarkMap })

  } catch (error: unknown) {
    apiLogger.error('Error checking batch bookmarks:', error)
    return NextResponse.json({ bookmarks: {} })
  }
}
