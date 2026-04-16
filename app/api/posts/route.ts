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
  success,
  successWithPagination,
  validateString,
  validateNumber,
  validateEnum,
  ApiError,
  ErrorCode,
} from '@/lib/api'
import { withPublic, withAuth } from '@/lib/api/middleware'
import { badRequest } from '@/lib/api/response'
import { socialFeatureGuard } from '@/lib/features'
import { getPosts, createPost, getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'
import { getWeightedPosts } from '@/lib/data/posts-weighted'
import { getServerCache, setServerCache, deleteServerCacheByPrefix, CacheTTL } from '@/lib/utils/server-cache'
import { get as cacheGet, set as cacheSet, del as cacheDel } from '@/lib/cache'
import { fireAndForget } from '@/lib/utils/logger'
import { extractAndSyncHashtags } from '@/lib/data/hashtags'

// Zod schema for POST /api/posts
const CreatePostSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200, 'Title must be at most 200 characters'),
  content: z.string().min(1, 'Content is required').max(10000, 'Content must be at most 10000 characters'),
  group_id: z.string().uuid().optional().nullable(),
  poll_enabled: z.boolean().optional().default(false),
  visibility: z.enum(['public', 'followers', 'group']).optional().default('public'),
  is_sensitive: z.boolean().optional().default(false),
  content_warning: z.string().max(200).optional().nullable(),
})

// 缓存键前缀
const POSTS_CACHE_PREFIX = 'posts:'

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

export const GET = withPublic(async ({ user, supabase, request }) => {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { searchParams } = new URL(request.url)

  const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
  const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
  const group_id = validateString(searchParams.get('group_id')) ?? undefined
  const group_ids = searchParams.get('group_ids') ? searchParams.get('group_ids')!.split(',').filter(Boolean) : undefined
  const author_handle = validateString(searchParams.get('author_handle')) ?? undefined
  const sort_by = validateEnum(
    searchParams.get('sort_by'),
    ['created_at', 'hot_score', 'like_count', 'personalized', 'following'] as const
  ) ?? 'created_at'
  const sort_order = validateEnum(
    searchParams.get('sort_order'),
    ['asc', 'desc'] as const
  ) ?? 'desc'

  // 权重增强排序参数
  const enable_weight = searchParams.get('enable_weight') === 'true'
  const weight_factor = validateNumber(searchParams.get('weight_factor'), { min: 0, max: 1 }) ?? 0.3
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

  // For hot posts (first page, no filters), check Redis cache first
  const isHotQuery = sort_by === 'hot_score' && offset === 0 && !group_id && !author_handle
  const HOT_POSTS_REDIS_KEY = 'hot_posts:top50'

  let posts: Awaited<ReturnType<typeof getPosts>> | null = null

  // Personalized feed: call RPC and return early
  if (sort_by === 'personalized') {
    if (user) {
      const { data: feedData } = await supabase.rpc(
        'get_personalized_feed',
        { p_user_id: user.id, p_limit: limit, p_offset: offset }
      )

      if (feedData && Array.isArray(feedData) && feedData.length > 0) {
        const postIds = feedData.map((r: { post_id: string }) => r.post_id)
        const { data: fullPosts } = await supabase
          .from('posts')
          .select('*, author:users!posts_author_id_fkey(id, handle, display_name, avatar_url), group:groups!posts_group_id_fkey(id, name, name_en, avatar_url)')
          .in('id', postIds)

        const postMap = new Map((fullPosts || []).map((p: { id: string }) => [p.id, p]))
        posts = postIds
          .map((id: string) => postMap.get(id))
          .filter(Boolean) as Awaited<ReturnType<typeof getPosts>>
      }
    }

    // Fallback to hot_score if not logged in or RPC returned empty
    if (!posts || posts.length === 0) {
      posts = await getPosts(supabase, {
        limit, offset, group_id, group_ids, author_handle,
        sort_by: 'hot_score', sort_order: 'desc',
        viewer_id: user?.id, language: langFilter,
      })
    }
  }

  // Following feed: posts from users the current user follows (Mastodon home timeline pattern)
  if (sort_by === 'following') {
    if (user) {
      const { data: followData } = await supabase
        .from('user_follows')
        .select('following_id')
        .eq('follower_id', user.id)

      const followingIds = (followData || []).map((f: { following_id: string }) => f.following_id)

      if (followingIds.length > 0) {
        posts = await getPosts(supabase, {
          limit, offset,
          sort_by: 'created_at', sort_order: 'desc',
          viewer_id: user.id, language: langFilter,
          author_ids: followingIds,
        })
      }
    }

    // Fallback to hot if not logged in or no follows
    if (!posts || posts.length === 0) {
      posts = await getPosts(supabase, {
        limit, offset,
        sort_by: 'hot_score', sort_order: 'desc',
        viewer_id: user?.id, language: langFilter,
      })
    }

    // Attach user state
    let userReactions: Map<string, 'up' | 'down'> = new Map()
    let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()
    if (user && posts.length > 0) {
      const postIds = posts.map(p => p.id)
      const [reactions, votes] = await Promise.all([
        getUserPostReactions(supabase, postIds, user.id),
        getUserPostVotes(supabase, postIds, user.id),
      ])
      userReactions = reactions
      userVotes = votes
    }
    const postsWithUserState = posts.map(post => ({
      ...post,
      user_reaction: userReactions.get(post.id) || null,
      user_vote: userVotes.get(post.id) || null,
    }))
    return successWithPagination(
      { posts: postsWithUserState },
      { limit, offset, has_more: posts.length === limit }
    )
  }

  if (isHotQuery) {
    try {
      const cachedHot = await cacheGet<Awaited<ReturnType<typeof getPosts>>>(HOT_POSTS_REDIS_KEY)
      if (cachedHot) {
        posts = cachedHot.slice(0, limit)
      }
    } catch {
      // Intentionally swallowed: Redis cache miss or error, fall through to DB query
    }
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
        limit: isHotQuery ? 50 : limit, // Fetch more for hot posts to populate Redis cache
        offset,
        group_id,
        group_ids,
        author_handle,
        sort_by,
        sort_order,
        enable_weight,
        weight_factor,
      })
    } else {
      // Use standard posts query
      // Note: 'personalized' and 'following' sort_by values return early above,
      // so sort_by is narrowed to the three DB-supported values here.
      posts = await getPosts(supabase, {
        limit: isHotQuery ? 50 : limit, // Fetch more for hot posts to populate Redis cache
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

    // For hot posts, also cache in Redis (5 minutes, matches cron interval)
    if (isHotQuery && posts.length > 0) {
      fireAndForget(cacheSet(HOT_POSTS_REDIS_KEY, posts, { ttl: 300 }), 'Cache hot posts to Redis')
    }

    // Trim to requested limit if we fetched more for cache
    if (isHotQuery && posts.length > limit) {
      posts = posts.slice(0, limit)
    }
  }

  // 如果用户已登录，获取用户的点赞和投票状态（并行获取）
  let userReactions: Map<string, 'up' | 'down'> = new Map()
  let userVotes: Map<string, 'bull' | 'bear' | 'wait'> = new Map()

  if (user && posts.length > 0) {
    const postIds = posts.map(p => p.id)

    // Parallel获取用户反应和投票状态
    const [reactions, votes] = await Promise.all([
      getUserPostReactions(supabase, postIds, user.id),
      getUserPostVotes(supabase, postIds, user.id),
    ])

    userReactions = reactions
    userVotes = votes
  }

  // 添加用户状态到帖子
  const postsWithUserState = posts.map(post => ({
    ...post,
    user_reaction: userReactions.get(post.id) || null,
    user_vote: userVotes.get(post.id) || null,
  }))

  return successWithPagination(
    { posts: postsWithUserState },
    { limit, offset, has_more: posts.length === limit }
  )
}, { name: 'posts-list', rateLimit: 'public', readsAuth: true })

export const POST = withAuth(async ({ user, supabase, request }) => {
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
  const { title, content, poll_enabled, visibility, is_sensitive, content_warning } = parsed.data
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
      .then(r => ({ score: r.data?.reputation_score ?? 0, verified: r.data?.is_verified_trader ?? false }))
      .catch(() => ({ score: 0, verified: false })),
  ])

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
  const mentionHandles = [...new Set([...content.matchAll(mentionRegex)].map((m: RegExpExecArray) => m[1]))]
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
            .update({ mentions: mentionedUsers.map((u: { id: string; handle: string }) => u.handle) })
            .eq('id', post.id)

          // Send mention notifications
          for (const mentioned of mentionedUsers) {
            if (mentioned.id === user.id) continue
            await supabase.from('notifications').insert({
              user_id: mentioned.id,
              type: 'mention',
              title: `${userHandle} mentioned you in a post`,
              message: (title || content).slice(0, 100),
              actor_id: user.id,
              link: `/post/${post.id}`,
              reference_id: post.id,
              read: false,
            })
          }
        }
      })(),
      'Parse mentions and send notifications'
    )
  }

  // 创建帖子后清除相关缓存（await Redis to avoid race with next GET）
  deleteServerCacheByPrefix(POSTS_CACHE_PREFIX)
  await cacheDel('hot_posts:top50').catch(() => {})

  return success({ post }, 201)
}, { name: 'posts-create', rateLimit: 'write' })
