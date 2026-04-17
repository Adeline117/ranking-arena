/**
 * 帖子转发 API
 * POST /api/posts/[id]/repost - 转发帖子（创建新帖子引用原始帖子）
 *
 * 转发会创建一个新的帖子：
 * - 新帖子的 original_post_id 指向被转发的帖子
 * - 用户可以添加自己的评论作为新帖子的内容
 * - 新帖子可以被其他人点赞、评论、再次转发
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

// 转发帖子 - 创建新帖子
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // Extract post id from URL path since middleware doesn't pass route context
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    // /api/posts/[id]/repost → index of 'posts' + 1 = id
    const postsIdx = pathParts.indexOf('posts')
    const id = pathParts[postsIdx + 1]

    if (!id) {
      return NextResponse.json({ error: 'Missing post ID' }, { status: 400 })
    }

    // 解析请求体
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      body = {}
    }
    const comment = (body.comment as string)?.trim() || ''

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
        title: comment ? comment.slice(0, 100) : `RT: ${originalPost.title}`.slice(0, 100),
        content: comment || '',
        author_id: user.id,
        author_handle: userHandle,
        original_post_id: rootPostId,
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
          type: 'like',
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
      message: 'Repost successful',
    })
  },
  { name: 'posts/repost', rateLimit: 'write' }
)
