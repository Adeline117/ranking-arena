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
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'

const MAX_REPOST_COMMENT_LENGTH = 280
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

    if (!id || !UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    // 解析请求体
    let body: Record<string, unknown>
    try {
      const parsedBody: unknown = await request.json()
      body =
        parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)
          ? (parsedBody as Record<string, unknown>)
          : {}
    } catch {
      body = {}
    }
    if (body.comment != null && typeof body.comment !== 'string') {
      return NextResponse.json({ error: 'Comment must be a string' }, { status: 400 })
    }
    const rawComment = (body.comment as string | undefined)?.trim() || ''
    if (rawComment.length > MAX_REPOST_COMMENT_LENGTH) {
      return NextResponse.json(
        { error: `Comment must be at most ${MAX_REPOST_COMMENT_LENGTH} characters` },
        { status: 400 }
      )
    }
    const { sanitizeText } = await import('@/lib/utils/sanitize')
    const comment = sanitizeText(rawComment, {
      preserveNewlines: true,
      maxLength: MAX_REPOST_COMMENT_LENGTH,
    })

    if (!(await canServiceActorReadPost(supabase, id, user.id))) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    // Resolve every repost-of-a-repost to one canonical root post.
    const { data: requestedPost, error: requestedPostError } = await supabase
      .from('posts')
      .select('id, original_post_id')
      .eq('id', id)
      .is('deleted_at', null)
      .maybeSingle()

    if (requestedPostError) {
      logger.error('Error loading repost target:', requestedPostError)
      return NextResponse.json({ error: 'Failed to load post' }, { status: 500 })
    }
    if (!requestedPost) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const rootPostId = requestedPost.original_post_id || requestedPost.id
    const { data: rootPost, error: rootPostError } = await supabase
      .from('posts')
      .select(
        'id, title, author_id, repost_count, original_post_id, visibility, group_id, is_sensitive, content_warning'
      )
      .eq('id', rootPostId)
      .is('deleted_at', null)
      .maybeSingle()

    if (rootPostError) {
      logger.error('Error loading root post:', rootPostError)
      return NextResponse.json({ error: 'Failed to load post' }, { status: 500 })
    }
    if (!rootPost) {
      return NextResponse.json({ error: 'Original post not found' }, { status: 404 })
    }
    // A global repost would widen the audience of follower-only/group content.
    // Until scoped group reposts have an explicit product contract, fail closed.
    if (
      rootPost.original_post_id !== null ||
      rootPost.visibility !== 'public' ||
      rootPost.group_id !== null
    ) {
      return NextResponse.json({ error: 'Original post not found' }, { status: 404 })
    }
    if (rootPost.author_id === user.id) {
      return NextResponse.json({ error: 'Cannot repost your own post' }, { status: 403 })
    }

    // Fast, user-friendly duplicate check. The partial unique index added by
    // 20260715090000 is the race-safe enforcement at insert time.
    const { data: existingRepost, error: existingRepostError } = await supabase
      .from('posts')
      .select('id')
      .eq('author_id', user.id)
      .eq('original_post_id', rootPostId)
      .is('deleted_at', null)
      .maybeSingle()
    if (existingRepostError) {
      logger.error('Error checking existing repost:', existingRepostError)
      return NextResponse.json({ error: 'Failed to check repost status' }, { status: 500 })
    }
    if (existingRepost) {
      return NextResponse.json(
        {
          error: 'Already reposted',
          code: 'already_reposted',
          post_id: existingRepost.id,
          root_post_id: rootPostId,
          repost_count: rootPost.repost_count || 0,
        },
        { status: 409 }
      )
    }

    // 获取用户 handle
    const { data: userProfile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', user.id)
      .maybeSingle()

    const userHandle = userProfile?.handle || user.email?.split('@')[0] || 'user'

    // 创建新帖子作为转发
    const { data: newPost, error: insertError } = await supabase
      .from('posts')
      .insert({
        title: comment ? comment.slice(0, 100) : `RT: ${rootPost.title}`.slice(0, 100),
        content: comment || '',
        author_id: user.id,
        author_handle: userHandle,
        original_post_id: rootPostId,
        poll_enabled: false,
        visibility: 'public',
        is_sensitive: rootPost.is_sensitive === true,
        content_warning: rootPost.content_warning,
      })
      .select('id')
      .single()

    if (insertError) {
      if (
        insertError.code === '23505' &&
        insertError.message?.includes('uniq_posts_active_repost_author_root')
      ) {
        const [{ data: concurrentRepost }, { data: concurrentRoot }] = await Promise.all([
          supabase
            .from('posts')
            .select('id')
            .eq('author_id', user.id)
            .eq('original_post_id', rootPostId)
            .is('deleted_at', null)
            .maybeSingle(),
          supabase.from('posts').select('repost_count').eq('id', rootPostId).maybeSingle(),
        ])
        return NextResponse.json(
          {
            error: 'Already reposted',
            code: 'already_reposted',
            post_id: concurrentRepost?.id,
            root_post_id: rootPostId,
            repost_count: concurrentRoot?.repost_count ?? rootPost.repost_count ?? 0,
          },
          { status: 409 }
        )
      }
      if (insertError.code === '23514') {
        return NextResponse.json({ error: 'Post is no longer repostable' }, { status: 409 })
      }
      logger.error('Error creating repost:', insertError)
      return NextResponse.json({ error: 'Repost failed' }, { status: 500 })
    }

    // The database trigger maintains this cache from canonical repost rows.
    const { data: refreshedRoot, error: refreshedRootError } = await supabase
      .from('posts')
      .select('repost_count')
      .eq('id', rootPostId)
      .single()
    if (refreshedRootError) {
      logger.error('Repost created but refreshed count could not be read:', refreshedRootError)
    }
    const repostCount =
      typeof refreshedRoot?.repost_count === 'number'
        ? refreshedRoot.repost_count
        : (rootPost.repost_count || 0) + 1

    // Notify original post author (fire-and-forget, deduped)
    if (rootPost.author_id && rootPost.author_id !== user.id) {
      sendNotification(
        supabase,
        {
          user_id: rootPost.author_id,
          type: 'comment',
          title: `${userHandle} reposted your post`,
          message: (rootPost.title || '').slice(0, 100) || 'your post',
          actor_id: user.id,
          link: `/post/${newPost.id}`,
          reference_id: rootPost.id,
          read: false,
        },
        'Repost notification'
      )
    }

    return NextResponse.json({
      success: true,
      post_id: newPost.id,
      root_post_id: rootPostId,
      repost_count: repostCount,
      message: 'Repost successful',
    })
  },
  { name: 'posts/repost', rateLimit: 'write' }
)
