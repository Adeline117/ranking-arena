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
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

type RouteContext = { params: Promise<{ id: string }> }

// 转发帖子 - 创建新帖子
export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id } = await context.params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
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
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
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
        title: comment ? comment.slice(0, 100) : `RT: ${originalPost.title}`.slice(0, 100), // 用评论作为标题，无评论则引用原帖标题
        content: comment || '', // 用户的转发评论
        author_id: user.id,
        author_handle: userHandle,
        original_post_id: rootPostId, // 指向最原始的帖子
        poll_enabled: false,
      })
      .select('id')
      .single()

    if (insertError) {
      logger.error('Error creating repost:', insertError)
      return NextResponse.json({ error: 'Repost failed' }, { status: 500 })
    }

    // Notify original post author (fire-and-forget)
    if (originalPost.author_id && originalPost.author_id !== user.id) {
      supabase
        .from('notifications')
        .insert({
          user_id: originalPost.author_id,
          type: 'like', // repost type — use 'like' as closest valid type
          title: `${userHandle} reposted your post`,
          message: (originalPost.title || '').slice(0, 100) || 'your post',
          actor_id: user.id,
          link: `/post/${newPost.id}`,
          reference_id: originalPost.id,
          read: false,
        })
        .then(({ error: notifError }) => {
          if (notifError) logger.warn('[repost] Notification insert failed:', notifError)
        })
    }

    return NextResponse.json({
      success: true,
      post_id: newPost.id,
      message: 'Repost successful'
    })

  } catch (error: unknown) {
    logger.error('Error creating repost:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
