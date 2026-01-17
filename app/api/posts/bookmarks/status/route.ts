/**
 * 批量检查帖子收藏状态 API
 * POST /api/posts/bookmarks/status - 检查多个帖子的收藏状态
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { apiLogger } from '@/lib/utils/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 批量检查多个帖子的收藏状态
export async function POST(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ bookmarks: {} })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ bookmarks: {} })
    }

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

  } catch (error) {
    apiLogger.error('Error checking batch bookmarks:', error)
    return NextResponse.json({ bookmarks: {} })
  }
}
