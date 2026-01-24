/**
 * 帖子列表 API
 * GET /api/posts - 获取帖子列表
 * POST /api/posts - 创建新帖子
 * 
 * 性能优化：
 * - 未登录用户使用缓存
 * - 并行获取用户反应和投票状态
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  getAuthUser,
  requireAuth,
  getUserHandle,
  success,
  successWithPagination,
  handleError,
  validateString,
  validateNumber,
  validateEnum,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import { getPosts, createPost, getUserPostReactions, getUserPostVotes } from '@/lib/data/posts'
import { getServerCache, setServerCache, deleteServerCacheByPrefix, CacheTTL } from '@/lib/utils/server-cache'
import { get as cacheGet, set as cacheSet } from '@/lib/cache'

// 缓存键前缀
const POSTS_CACHE_PREFIX = 'posts:'

// 生成缓存键
function getCacheKey(params: {
  limit: number
  offset: number
  group_id?: string
  author_handle?: string
  sort_by: string
  sort_order: string
}): string {
  return `${POSTS_CACHE_PREFIX}${params.sort_by}:${params.sort_order}:${params.limit}:${params.offset}:${params.group_id || ''}:${params.author_handle || ''}`
}

export async function GET(request: NextRequest) {
  // 公开 API 限流：每分钟 100 次
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.public)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const supabase = getSupabaseAdmin()
    const { searchParams } = new URL(request.url)
    
    const limit = validateNumber(searchParams.get('limit'), { min: 1, max: 100 }) ?? 20
    const offset = validateNumber(searchParams.get('offset'), { min: 0 }) ?? 0
    const group_id = validateString(searchParams.get('group_id')) ?? undefined
    const group_ids = searchParams.get('group_ids') ? searchParams.get('group_ids')!.split(',').filter(Boolean) : undefined
    const author_handle = validateString(searchParams.get('author_handle')) ?? undefined
    const sort_by = validateEnum(
      searchParams.get('sort_by'),
      ['created_at', 'hot_score', 'like_count'] as const
    ) ?? 'created_at'
    const sort_order = validateEnum(
      searchParams.get('sort_order'),
      ['asc', 'desc'] as const
    ) ?? 'desc'

    // 检查用户登录状态
    const user = await getAuthUser(request)
    
    // 生成缓存键
    const cacheKey = getCacheKey({ limit, offset, group_id: group_id || (group_ids ? group_ids.join(',') : undefined), author_handle, sort_by, sort_order })
    
    // For hot posts (first page, no filters), check Redis cache first
    const isHotQuery = sort_by === 'hot_score' && offset === 0 && !group_id && !author_handle
    const HOT_POSTS_REDIS_KEY = 'hot_posts:top50'

    let posts: Awaited<ReturnType<typeof getPosts>> | null = null

    if (isHotQuery) {
      try {
        const cachedHot = await cacheGet<Awaited<ReturnType<typeof getPosts>>>(HOT_POSTS_REDIS_KEY)
        if (cachedHot) {
          posts = cachedHot.slice(0, limit)
        }
      } catch {
        // Redis cache miss, continue
      }
    }

    if (!posts) {
      // Try server memory cache
      posts = getServerCache<Awaited<ReturnType<typeof getPosts>>>(cacheKey)
    }

    if (!posts) {
      // Cache miss, fetch from database
      posts = await getPosts(supabase, {
        limit: isHotQuery ? 50 : limit, // Fetch more for hot posts to populate Redis cache
        offset,
        group_id,
        group_ids,
        author_handle,
        sort_by,
        sort_order,
      })

      // Cache in server memory (1 minute)
      setServerCache(cacheKey, posts, CacheTTL.SHORT)

      // For hot posts, also cache in Redis (5 minutes, matches cron interval)
      if (isHotQuery && posts.length > 0) {
        cacheSet(HOT_POSTS_REDIS_KEY, posts, { ttl: 300 }).catch(() => {})
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
      
      // 🚀 并行获取用户反应和投票状态
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
  } catch (error) {
    return handleError(error, 'posts GET')
  }
}

export async function POST(request: NextRequest) {
  // 写操作限流：每分钟 30 次
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResponse) return rateLimitResponse

  try {
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()
    const body = await request.json()

    // 验证输入
    const title = validateString(body.title, { required: true, minLength: 1, maxLength: 200, fieldName: '标题' })!
    const content = validateString(body.content, { required: true, minLength: 1, maxLength: 10000, fieldName: '内容' })!
    const group_id = validateString(body.group_id) ?? undefined
    const poll_enabled = body.poll_enabled === true

    // 获取用户 handle
    const userHandle = await getUserHandle(user.id, user.email)

    const post = await createPost(supabase, user.id, userHandle, {
      title,
      content,
      group_id,
      poll_enabled,
    })

    // 创建帖子后清除相关缓存
    deleteServerCacheByPrefix(POSTS_CACHE_PREFIX)

    return success({ post }, 201)
  } catch (error) {
    return handleError(error, 'posts POST')
  }
}
