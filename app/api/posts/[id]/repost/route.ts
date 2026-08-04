/**
 * 帖子转发 API
 * POST /api/posts/[id]/repost - 转发帖子（创建新帖子引用原始帖子）
 *
 * 转发会创建一个新的帖子：
 * - 新帖子的 original_post_id 指向被转发的帖子
 * - 用户可以添加自己的评论作为新帖子的内容
 * - 新帖子可以被其他人点赞、评论、再次转发
 */

import { NextResponse, type NextRequest } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'
import { POST_REPOST_OPERATION } from '@/lib/reposts/post-repost-client-contract'

const MAX_REPOST_COMMENT_LENGTH = 280
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const REQUEST_ID_RE = /^[0-9a-f]{32}$/
const PRIVATE_NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
} as const

type StrictRepostRequest = {
  operation: typeof POST_REPOST_OPERATION
  requestId: string
}

type RepostReceiptInput = {
  actorId: string
  sourcePostId: string
  rootPostId: string
  requestId: string
  action: 'created' | 'already_exists'
  repostPostId: string
  repostCount: number
}

function privateNoStore(response: NextResponse): NextResponse {
  for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS)) {
    response.headers.set(name, value)
  }
  return response
}

function canonicalUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_RE.test(value) ? value.toLowerCase() : null
}

function canonicalRepostCount(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null
}

function strictReceipt(input: RepostReceiptInput): Record<string, unknown> {
  return {
    actor_id: input.actorId,
    source_post_id: input.sourcePostId,
    root_post_id: input.rootPostId,
    request_id: input.requestId,
    operation: POST_REPOST_OPERATION,
    action: input.action,
    repost_post_id: input.repostPostId,
    repost_count: input.repostCount,
  }
}

// 转发帖子 - 创建新帖子
const postRepostHandler = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // Extract post id from URL path since middleware doesn't pass route context
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    // /api/posts/[id]/repost → index of 'posts' + 1 = id
    const postsIdx = pathParts.indexOf('posts')
    const id = pathParts[postsIdx + 1]

    const sourcePostId = canonicalUuid(id)
    if (!sourcePostId) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    // 解析请求体
    let body: Record<string, unknown>
    try {
      const parsedBody: unknown = await request.json()
      if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
        return NextResponse.json({ error: 'Invalid repost request' }, { status: 400 })
      }
      body = parsedBody as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const bodyKeys = Object.keys(body)
    const hasStrictRequestMarker =
      Object.hasOwn(body, 'operation') || Object.hasOwn(body, 'request_id')
    let strictRequest: StrictRepostRequest | null = null
    if (hasStrictRequestMarker) {
      if (
        bodyKeys.length !== 3 ||
        !bodyKeys.includes('operation') ||
        !bodyKeys.includes('request_id') ||
        !bodyKeys.includes('comment') ||
        bodyKeys.some((key) => key !== 'operation' && key !== 'request_id' && key !== 'comment') ||
        body.operation !== POST_REPOST_OPERATION ||
        typeof body.request_id !== 'string' ||
        !REQUEST_ID_RE.test(body.request_id) ||
        typeof body.comment !== 'string'
      ) {
        return NextResponse.json({ error: 'Invalid repost request' }, { status: 400 })
      }
      strictRequest = {
        operation: POST_REPOST_OPERATION,
        requestId: body.request_id,
      }
    } else if (bodyKeys.length > 1 || (bodyKeys.length === 1 && bodyKeys[0] !== 'comment')) {
      return NextResponse.json({ error: 'Invalid repost request' }, { status: 400 })
    }
    if (!strictRequest && body.comment != null && typeof body.comment !== 'string') {
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

    const actorId = canonicalUuid(user.id)
    if (strictRequest && !actorId) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    if (!(await canServiceActorReadPost(supabase, sourcePostId, user.id))) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    // Resolve every repost-of-a-repost to one canonical root post.
    const { data: requestedPost, error: requestedPostError } = await supabase
      .from('posts')
      .select('id, original_post_id')
      .eq('id', sourcePostId)
      .is('deleted_at', null)
      .maybeSingle()

    if (requestedPostError) {
      logger.error('Error loading repost target:', requestedPostError)
      return NextResponse.json({ error: 'Failed to load post' }, { status: 500 })
    }
    if (!requestedPost) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    const rootPostId = canonicalUuid(requestedPost.original_post_id || requestedPost.id)
    if (!rootPostId) {
      logger.error('Repost target resolved to an invalid root post ID')
      return NextResponse.json({ error: 'Failed to load post' }, { status: 500 })
    }
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
      const repostPostId = canonicalUuid(existingRepost.id)
      const repostCount = canonicalRepostCount(rootPost.repost_count)
      if (!repostPostId || repostCount === null) {
        logger.error('Existing repost could not be reconciled to canonical state')
        return NextResponse.json({ error: 'Failed to reconcile repost status' }, { status: 500 })
      }
      if (strictRequest && actorId) {
        return NextResponse.json(
          strictReceipt({
            actorId,
            sourcePostId,
            rootPostId,
            requestId: strictRequest.requestId,
            action: 'already_exists',
            repostPostId,
            repostCount,
          }),
          { status: 409 }
        )
      }
      return NextResponse.json(
        {
          error: 'Already reposted',
          code: 'already_reposted',
          post_id: repostPostId,
          root_post_id: rootPostId,
          repost_count: repostCount,
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
        const [concurrentRepostResult, concurrentRootResult] = await Promise.all([
          supabase
            .from('posts')
            .select('id')
            .eq('author_id', user.id)
            .eq('original_post_id', rootPostId)
            .is('deleted_at', null)
            .maybeSingle(),
          supabase.from('posts').select('repost_count').eq('id', rootPostId).maybeSingle(),
        ])
        const repostPostId = canonicalUuid(concurrentRepostResult.data?.id)
        const repostCount = canonicalRepostCount(concurrentRootResult.data?.repost_count)
        if (
          concurrentRepostResult.error ||
          concurrentRootResult.error ||
          !repostPostId ||
          repostCount === null
        ) {
          logger.error('Concurrent repost could not be reconciled to canonical state')
          return NextResponse.json({ error: 'Failed to reconcile repost status' }, { status: 500 })
        }
        if (strictRequest && actorId) {
          return NextResponse.json(
            strictReceipt({
              actorId,
              sourcePostId,
              rootPostId,
              requestId: strictRequest.requestId,
              action: 'already_exists',
              repostPostId,
              repostCount,
            }),
            { status: 409 }
          )
        }
        return NextResponse.json(
          {
            error: 'Already reposted',
            code: 'already_reposted',
            post_id: repostPostId,
            root_post_id: rootPostId,
            repost_count: repostCount,
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
    const repostPostId = canonicalUuid(newPost?.id)
    const repostCount = canonicalRepostCount(refreshedRoot?.repost_count)
    if (refreshedRootError || !repostPostId || repostCount === null) {
      logger.error('Repost created but refreshed count could not be read:', refreshedRootError)
      return NextResponse.json({ error: 'Repost result could not be verified' }, { status: 500 })
    }

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
          link: `/post/${repostPostId}`,
          reference_id: rootPost.id,
          read: false,
        },
        'Repost notification'
      )
    }

    if (strictRequest && actorId) {
      return NextResponse.json(
        strictReceipt({
          actorId,
          sourcePostId,
          rootPostId,
          requestId: strictRequest.requestId,
          action: 'created',
          repostPostId,
          repostCount,
        }),
        { status: 201 }
      )
    }

    return NextResponse.json({
      success: true,
      post_id: repostPostId,
      root_post_id: rootPostId,
      repost_count: repostCount,
      message: 'Repost successful',
    })
  },
  { name: 'posts/repost', rateLimit: 'write' }
)

export async function POST(request: Request): Promise<NextResponse> {
  return privateNoStore(await postRepostHandler(request as NextRequest))
}
