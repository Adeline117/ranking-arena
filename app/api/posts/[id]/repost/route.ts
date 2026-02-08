/**
 * 帖子转发 API
 * POST /api/posts/[id]/repost - 转发帖子（创建新帖子引用原始帖子）
 * 
 * 转发会创建一个新的帖子：
 * - 新帖子的 original_post_id 指向被转发的帖子
 * - 用户可以添加自己的评论作为新帖子的内容
 * - 新帖子可以被其他人点赞、评论、再次转发
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

type RouteContext = { params: Promise<{ id: string }> }

// 转发帖子 - 创建新帖子
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id } = await context.params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

    // 解析请求体
    const body = await request.json().catch(() => ({}))
    const comment = body.comment?.trim() || ''

    // 检查原始帖子是否存在
    const { data: originalPost } = await supabase
      .from('posts')
      .select('id, title, author_id, original_post_id')
      .eq('id', id)
      .maybeSingle()

    if (!originalPost) {
      return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
    }

    // 获取用户 handle
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', user.id)
      .maybeSingle()

    const userHandle = userProfile?.handle || user.email?.split('@')[0] || 'user'

    // 找到最原始的帖子（如果是转发的转发，追溯到源头）
    const rootPostId = originalPost.original_post_id || originalPost.id

    // 创建新帖子作为转发
    const { data: newPost, error: insertError } = await supabase
      .from('posts')
      .insert({
        title: comment ? comment.slice(0, 100) : '', // 用评论作为标题，截取前100字符
        content: comment || '', // 用户的转发评论
        author_id: user.id,
        author_handle: userHandle,
        original_post_id: rootPostId, // 指向最原始的帖子
        poll_enabled: false,
      })
      .select('id')
      .single()

    if (insertError) {
      console.error('Error creating repost:', insertError)
      return NextResponse.json({ error: '转发失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      post_id: newPost.id,
      message: '转发成功'
    })

  } catch (error: unknown) {
    console.error('Error creating repost:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
