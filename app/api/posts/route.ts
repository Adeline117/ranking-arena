/**
 * 帖子列表 API
 * GET /api/posts - 获取帖子列表
 * POST /api/posts - 创建新帖子
 *
 * 性能优化：
 * - 未登录用户使用缓存
 * - 并行获取用户反应和投票状态
 */

export const runtime = 'nodejs'

import { z } from 'zod'
import {
  getUserHandle,
  handleError,
  success,
  successWithPagination,
  unauthorized,
  validateString,
  validateNumber,
  validateEnum,
  ApiError,
  ErrorCode,
} from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { badRequest, forbidden, notFound } from '@/lib/api/response'
import { socialFeatureGuard } from '@/lib/features'
import { getPosts, createPost, getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'
import { getWeightedPosts } from '@/lib/data/posts-weighted'
import {
  getServerCache,
  setServerCache,
  deleteServerCacheByPrefix,
  CacheTTL,
} from '@/lib/utils/server-cache'
import { del as cacheDel } from '@/lib/cache'
import { fireAndForget } from '@/lib/utils/logger'
import { sendNotifications } from '@/lib/data/notifications'
import { extractAndSyncHashtags } from '@/lib/data/hashtags'
import { logRpcError } from '@/lib/data/serving/log-rpc-error'
// sanitizeInput / sanitizeText are dynamically imported inside POST only —
// keeps the sanitize-html parser out of the GET handler's module graph at
// cold-start (the GET handler doesn't need it).

// Zod schema for POST /api/posts
const CreatePostSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
  content: z
    .string()
    .min(1, 'Content is required')
    .max(10000, 'Content must be at most 10000 characters'),
  group_id: z.string().uuid().optional().nullable(),
  poll_enabled: z.boolean().optional().default(false),
  visibility: z.enum(['public', 'followers', 'group']).optional().default('public'),
  is_sensitive: z.boolean().optional().default(false),
  content_warning: z.string().max(200).optional().nullable(),
})

const FollowingCursorSchema = z
  .object({
    created_at: z.string().datetime({ offset: true }),
    id: z.string().uuid(),
  })
  .strict()

const FollowingPostSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string(),
    content: z.string(),
    author_id: z.string().uuid(),
    author_handle: z.string(),
    author_avatar_url: z.string().nullable(),
    author_is_pro: z.boolean(),
    author_show_pro_badge: z.boolean(),
    group_id: z.string().uuid().nullable(),
    group_name: z.string().nullable(),
    group_name_en: z.string().nullable(),
    poll_enabled: z.boolean(),
    poll_id: z.string().uuid().nullable(),
    poll_bull: z.number().int().nonnegative(),
    poll_bear: z.number().int().nonnegative(),
    poll_wait: z.number().int().nonnegative(),
    like_count: z.number().int().nonnegative(),
    dislike_count: z.number().int().nonnegative(),
    comment_count: z.number().int().nonnegative(),
    bookmark_count: z.number().int().nonnegative(),
    repost_count: z.number().int().nonnegative(),
    view_count: z.number().int().nonnegative(),
    hot_score: z.number(),
    is_pinned: z.boolean(),
    images: z.array(z.string()).nullable(),
    created_at: z.string().datetime({ offset: true }),
    updated_at: z.string().datetime({ offset: true }).nullable(),
    original_post_id: z.string().uuid().nullable(),
    original_post: z
      .object({
        id: z.string().uuid(),
        title: z.string().nullable(),
        content: z.string().nullable(),
        author_handle: z.string().nullable(),
        author_avatar_url: z.string().nullable(),
        author_is_pro: z.boolean(),
        author_show_pro_badge: z.boolean(),
        images: z.array(z.string()).nullable(),
        created_at: z.string().datetime({ offset: true }),
      })
      .strict()
      .nullable(),
    visibility: z.enum(['public', 'followers', 'group']),
    is_sensitive: z.boolean(),
    content_warning: z.string().nullable(),
    language: z.string(),
  })
  .strict()

const FollowingPageSchema = z
  .object({
    posts: z.array(FollowingPostSchema).max(100),
    following_count: z.number().int().nonnegative(),
    has_more: z.boolean(),
    next_cursor: FollowingCursorSchema.nullable(),
  })
  .strict()

const FollowingRequestSchema = z
  .object({
    offset: z.literal(0),
    group_id: z.string().uuid().nullable(),
    group_ids: z.array(z.string().uuid()).max(100).nullable(),
    author_handle: z.string().max(64).nullable(),
    language: z.string().max(16).nullable(),
    before_created_at: z.string().datetime({ offset: true }).nullable(),
    before_id: z.string().uuid().nullable(),
  })
  .strict()
  .refine(
    (value) => (value.before_created_at === null) === (value.before_id === null),
    'Following cursor fields must be provided together'
  )

// 缓存键前缀
const POSTS_CACHE_PREFIX = 'posts:'
const PUBLIC_POSTS_CACHE_CONTROL = 'public, s-maxage=30, stale-while-revalidate=120'
const PRIVATE_POSTS_CACHE_CONTROL = 'private, no-store, max-age=0'

function setPostsReadCachePolicy<T extends Response>(response: T, isViewerOwned: boolean): T {
  response.headers.set(
    'Cache-Control',
    isViewerOwned ? PRIVATE_POSTS_CACHE_CONTROL : PUBLIC_POSTS_CACHE_CONTROL
  )
  if (isViewerOwned) {
    // Target both Vercel and any upstream/shared CDN explicitly. These headers
    // outrank the browser-facing Cache-Control header at their respective CDN.
    response.headers.set('CDN-Cache-Control', 'no-store')
    response.headers.set('Vercel-CDN-Cache-Control', 'no-store')
  }

  const vary = response.headers.get('Vary')
  const varyFields = (vary || '')
    .split(',')
    .map((field) => field.trim())
    .filter(Boolean)
  if (!varyFields.some((field) => field.toLowerCase() === 'authorization')) {
    varyFields.push('Authorization')
  }
  response.headers.set('Vary', varyFields.join(', '))

  return response
}

// 生成缓存键
//
// SECURITY (audit P1-8, 2026-04-09): MUST include viewer_id when getPosts
// is called with viewer_id, otherwise user A's filtered result (which
// excludes posts visible only to A's followers/groups) could be served to
// user B from the in-memory cache. The viewer parameter is what
// determines visibility filtering downstream — sharing across viewers is
// a cross-tenant leak.
//
// Cache hit rate trade-off: scoping by viewer reduces hit rate (separate
// bucket per logged-in user). The 'public' bucket (viewer = anon) is the
// most-cached path and still gets full sharing across anonymous visitors,
// which is where the cache pays for itself anyway.
function getCacheKey(params: {
  limit: number
  offset: number
  group_id?: string
  author_handle?: string
  sort_by: string
  sort_order: string
  enable_weight?: boolean
  weight_factor?: number
  viewer_id?: string | null
  language?: string
}): string {
  const viewer = params.viewer_id || 'anon'
  return `${POSTS_CACHE_PREFIX}${params.sort_by}:${params.sort_order}:${params.limit}:${params.offset}:${params.group_id || ''}:${params.author_handle || ''}:${params.enable_weight || false}:${params.weight_factor || 0}:${viewer}:${params.language || ''}`
}

export const GET = withPublic(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const { searchParams } = new URL(request.url)
    const isViewerOwnedRequest = Boolean(user || request.headers.get('authorization'))

    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const group_id = validateString(searchParams.get('group_id')) ?? undefined
    const group_ids = searchParams.get('group_ids')
      ? searchParams.get('group_ids')!.split(',').filter(Boolean)
      : undefined
    const author_handle = validateString(searchParams.get('author_handle')) ?? undefined
    const sort_by =
      validateEnum(searchParams.get('sort_by'), [
        'created_at',
        'hot_score',
        'like_count',
        'personalized',
        'following',
      ] as const) ?? 'created_at'
    const sort_order =
      validateEnum(searchParams.get('sort_order'), ['asc', 'desc'] as const) ?? 'desc'

    // 权重增强排序参数
    const enable_weight = searchParams.get('enable_weight') === 'true'
    const weight_factor =
      validateNumber(searchParams.get('weight_factor'), { min: 0, max: 1 }) ?? 0.3
    const langFilter = validateString(searchParams.get('language')) ?? undefined

    // 生成缓存键 — must include viewer_id for visibility-correct caching
    // (audit P1-8). Anonymous users share a single bucket; logged-in users
    // each get their own to prevent cross-user filtered-result leakage.
    const cacheKey = getCacheKey({
      limit,
      offset,
      group_id: group_id || (group_ids ? group_ids.join(',') : undefined),
      author_handle,
      sort_by,
      sort_order,
      enable_weight,
      weight_factor,
      viewer_id: user?.id ?? null,
      language: langFilter,
    })

    let posts: Awaited<ReturnType<typeof getPosts>> | null = null

    // Personalized feed: call RPC and return early
    if (sort_by === 'personalized') {
      if (user) {
        const { data: feedData, error: feedError } = await supabase.rpc('get_personalized_feed', {
          p_user_id: user.id,
          p_limit: limit,
          p_offset: offset,
        })
        // Surface RPC drift: without this an error folds silently into the
        // hot/recent fallback below, so a broken personalized feed is invisible.
        if (feedError) logRpcError('get_personalized_feed', feedError)

        if (feedData && Array.isArray(feedData) && feedData.length > 0) {
          const postIds = feedData.map((r: { post_id: string }) => r.post_id)
          // posts.author_id has no FK in prod, so the users!posts_author_id_fkey
          // embed fails with PGRST200 (and users has no display_name column).
          // getPosts does the canonical two-step author merge via user_profiles.
          const fullPosts = await getPosts(supabase, {
            post_ids: postIds,
            limit: postIds.length,
            viewer_id: user.id,
            language: langFilter,
          })

          const postMap = new Map(fullPosts.map((p) => [p.id, p]))
          // Preserve RPC ranking order
          posts = postIds.map((id: string) => postMap.get(id)).filter(Boolean) as Awaited<
            ReturnType<typeof getPosts>
          >
        }
      }

      // Fallback to hot_score if not logged in or RPC returned empty
      if (!posts || posts.length === 0) {
        posts = await getPosts(supabase, {
          limit,
          offset,
          group_id,
          group_ids,
          author_handle,
          sort_by: 'hot_score',
          sort_order: 'desc',
          viewer_id: user?.id,
          language: langFilter,
        })
      }
    }

    // Following feed: posts from users the current user follows (Mastodon home timeline pattern)
    if (sort_by === 'following') {
      // This route is public for every other sort mode, but following is a
      // viewer-owned resource.  Never accept a caller-supplied viewer ID and
      // never substitute the anonymous/hot feed when authentication fails.
      if (!user) {
        return setPostsReadCachePolicy(
          unauthorized('Authentication required for following feed'),
          true
        )
      }

      const parsedFollowingRequest = FollowingRequestSchema.safeParse({
        offset,
        group_id: group_id ?? null,
        group_ids: group_ids ?? null,
        author_handle: author_handle ?? null,
        language: langFilter ?? null,
        before_created_at: searchParams.get('before_created_at'),
        before_id: searchParams.get('before_id'),
      })
      if (!parsedFollowingRequest.success) {
        return setPostsReadCachePolicy(badRequest('Invalid following feed filters or cursor'), true)
      }

      const followingRequest = parsedFollowingRequest.data
      const { data: pageData, error: pageError } = await supabase.rpc('get_following_posts_page', {
        p_viewer_id: user.id,
        p_limit: limit,
        p_before_created_at: followingRequest.before_created_at,
        p_before_id: followingRequest.before_id,
        p_group_id: followingRequest.group_id,
        p_group_ids: followingRequest.group_ids,
        p_author_handle: followingRequest.author_handle,
        p_language: followingRequest.language,
      })

      if (pageError) {
        logRpcError('get_following_posts_page', pageError)
        return setPostsReadCachePolicy(
          handleError(
            new ApiError('Failed to load following feed', {
              code: ErrorCode.DATABASE_ERROR,
            }),
            'posts-list following'
          ),
          true
        )
      }

      const parsedPage = FollowingPageSchema.safeParse(pageData)
      if (!parsedPage.success) {
        return setPostsReadCachePolicy(
          handleError(
            new ApiError('Following feed returned invalid data', {
              code: ErrorCode.DATABASE_ERROR,
            }),
            'posts-list following'
          ),
          true
        )
      }
      const page = parsedPage.data
      posts = page.posts as unknown as Awaited<ReturnType<typeof getPosts>>

      // Attach user state
      let userReactions: Map<string, 'up' | 'down'> = new Map()
      let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()
      if (user && posts.length > 0) {
        const postIds = posts.map((p) => p.id)
        const [reactions, votes] = await Promise.all([
          getUserPostReactions(supabase, postIds, user.id),
          getUserPostVotes(supabase, postIds, user.id),
        ])
        userReactions = reactions
        userVotes = votes
      }
      const postsWithUserState = posts.map((post) => ({
        ...post,
        user_reaction: userReactions.get(post.id) || null,
        user_vote: userVotes.get(post.id) || null,
      }))
      return setPostsReadCachePolicy(
        successWithPagination(
          {
            posts: postsWithUserState,
            following_count: page.following_count,
            viewer_id: user.id,
            next_cursor: page.next_cursor,
          },
          { limit, offset: 0, has_more: page.has_more }
        ),
        true
      )
    }

    if (!posts) {
      // Try server memory cache
      posts = getServerCache<Awaited<ReturnType<typeof getPosts>>>(cacheKey)
    }

    if (!posts) {
      // Cache miss, fetch from database
      if (enable_weight && sort_by === 'hot_score') {
        // Use weighted posts for enhanced sorting
        posts = await getWeightedPosts(supabase, {
          limit,
          offset,
          group_id,
          group_ids,
          author_handle,
          sort_by,
          sort_order,
          enable_weight,
          weight_factor,
          viewer_id: user?.id,
        })
      } else {
        // Use standard posts query
        // Note: 'personalized' and 'following' sort_by values return early above,
        // so sort_by is narrowed to the three DB-supported values here.
        posts = await getPosts(supabase, {
          limit,
          offset,
          group_id,
          group_ids,
          author_handle,
          sort_by: sort_by as 'created_at' | 'hot_score' | 'like_count',
          sort_order,
          viewer_id: user?.id,
          language: langFilter,
        })
      }

      // Cache in server memory (1 minute)
      setServerCache(cacheKey, posts, CacheTTL.SHORT)
    }

    // 如果用户已登录，获取用户的点赞和投票状态（并行获取）
    let userReactions: Map<string, 'up' | 'down'> = new Map()
    let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()

    if (user && posts.length > 0) {
      const postIds = posts.map((p) => p.id)

      // Parallel获取用户反应和投票状态
      const [reactions, votes] = await Promise.all([
        getUserPostReactions(supabase, postIds, user.id),
        getUserPostVotes(supabase, postIds, user.id),
      ])

      userReactions = reactions
      userVotes = votes
    }

    // 添加用户状态到帖子
    const postsWithUserState = posts.map((post) => ({
      ...post,
      user_reaction: userReactions.get(post.id) || null,
      user_vote: userVotes.get(post.id) || null,
    }))

    return setPostsReadCachePolicy(
      successWithPagination(
        { posts: postsWithUserState },
        { limit, offset, has_more: posts.length === limit }
      ),
      isViewerOwnedRequest
    )
  },
  { name: 'posts-list', rateLimit: 'public', readsAuth: true }
)

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON in request body')
    }

    // Zod 输入验证
    const parsed = CreatePostSchema.safeParse(body)
    if (!parsed.success) {
      throw new ApiError('Invalid input', {
        code: ErrorCode.VALIDATION_ERROR,
        details: { errors: parsed.error.flatten() },
      })
    }
    // Sanitize user content — strip HTML/scripts before DB storage (defense-in-depth)
    const { sanitizeInput, sanitizeText } = await import('@/lib/utils/sanitize')
    const title = sanitizeInput(parsed.data.title, { maxLength: 200 })
    const content = sanitizeText(parsed.data.content, { preserveNewlines: true, maxLength: 10000 })
    const content_warning = parsed.data.content_warning
      ? sanitizeInput(parsed.data.content_warning, { maxLength: 200 })
      : undefined
    const { poll_enabled, visibility, is_sensitive } = parsed.data
    const group_id = parsed.data.group_id ?? undefined

    // 并行获取用户 handle + reputation data
    const [userHandle, reputationResult] = await Promise.all([
      getUserHandle(user.id, user.email),
      Promise.resolve(
        supabase
          .from('user_profiles')
          .select('reputation_score, is_verified_trader')
          .eq('id', user.id)
          .maybeSingle()
      )
        .then((r) => ({
          score: r.data?.reputation_score ?? 0,
          verified: r.data?.is_verified_trader ?? false,
        }))
        .catch(() => ({ score: 0, verified: false })),
    ])

    // Group posting gate — this handler uses the service-role client, which
    // BYPASSES the `posts_insert_member` RLS policy, so the group rules must be
    // enforced here in code. Without it, any authed user can inject posts into
    // private/premium/dissolved groups and banned/muted users keep posting.
    if (group_id) {
      const [groupRes, memberRes, banRes] = await Promise.all([
        supabase.from('groups').select('dissolved_at').eq('id', group_id).maybeSingle(),
        supabase
          .from('group_members')
          .select('muted_until')
          .eq('group_id', group_id)
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('group_bans')
          .select('user_id') // composite PK — select user_id, not id
          .eq('group_id', group_id)
          .eq('user_id', user.id)
          .maybeSingle(),
      ])
      if (!groupRes.data) return notFound('Group not found')
      if (groupRes.data.dissolved_at)
        return badRequest('This group has been dissolved — no new posts')
      if (banRes.data) return forbidden('You are banned from this group')
      if (!memberRes.data) return forbidden('You must be a member to post in this group')
      const mutedUntil = memberRes.data.muted_until as string | null
      if (mutedUntil && new Date(mutedUntil) > new Date())
        return forbidden('You are muted in this group')
    }

    const post = await createPost(supabase, user.id, userHandle, {
      title,
      content,
      group_id,
      poll_enabled,
      visibility: group_id ? 'group' : visibility,
      is_sensitive,
      content_warning: content_warning ?? undefined,
      authorReputation: reputationResult,
    })

    // Extract and sync hashtags (fire-and-forget to not block response)
    fireAndForget(
      extractAndSyncHashtags(supabase, post.id, `${title} ${content}`),
      'Sync hashtags for post'
    )

    // Parse @mentions from content and send notifications (fire-and-forget)
    const mentionRegex = /@(\w+)/g
    const mentionHandles = [
      ...new Set([...content.matchAll(mentionRegex)].map((m: RegExpExecArray) => m[1])),
    ]
    if (mentionHandles.length > 0) {
      fireAndForget(
        (async () => {
          const { data: mentionedUsers } = await supabase
            .from('user_profiles')
            .select('id, handle')
            .in('handle', mentionHandles)

          if (mentionedUsers && mentionedUsers.length > 0) {
            // Store resolved mentions on the post
            await supabase
              .from('posts')
              .update({
                mentions: mentionedUsers.map((u: { id: string; handle: string }) => u.handle),
              })
              .eq('id', post.id)

            // Send mention notifications (deduped, each independently)
            const notificationRows = mentionedUsers
              .filter((m: { id: string }) => m.id !== user.id)
              .map((m: { id: string }) => ({
                user_id: m.id,
                type: 'mention' as const,
                title: `${userHandle} mentioned you in a post`,
                message: (title || content).slice(0, 100),
                actor_id: user.id,
                link: `/post/${post.id}`,
                reference_id: post.id,
                read: false,
              }))
            sendNotifications(supabase, notificationRows, 'Mention notifications')
          }
        })(),
        'Parse mentions and send notifications'
      )
    }

    // 创建帖子后清除相关缓存
    deleteServerCacheByPrefix(POSTS_CACHE_PREFIX)
    fireAndForget(cacheDel('hot_posts:top50'), 'delete-hot-posts-cache')

    return success({ post }, 201)
  },
  { name: 'posts-create', rateLimit: 'write' }
)
