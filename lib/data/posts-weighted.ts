/**
 * 用户权重增强的帖子数据层
 * 在现有排序基础上融入用户权重系统
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { PostWithAuthor, PostListOptions } from './posts'
import { logger } from '@/lib/logger'

/** Raw post row returned from the weighted query join */
interface WeightedPostRow {
  id: string
  title: string | null
  content: string | null
  author_id: string
  author_handle: string | null
  group_id: string | null
  poll_enabled: boolean | null
  poll_id: string | null
  poll_bull: number | null
  poll_bear: number | null
  poll_wait: number | null
  like_count: number | null
  dislike_count: number | null
  comment_count: number | null
  bookmark_count: number | null
  repost_count: number | null
  view_count: number | null
  hot_score: number | null
  is_pinned: boolean | null
  images: string[] | null
  created_at: string
  updated_at: string | null
  original_post_id: string | null
  group_name: string | null
  group_name_en: string | null
  author_weight: number | null
  weighted_score?: number
  groups?: { name: string; name_en: string | null } | null
}

/** Author profile info used in mapping */
interface AuthorProfile {
  handle: string | null
  avatar_url: string | null
  is_pro: boolean
  show_pro_badge: boolean
}

/** Original post summary for reposts */
interface OriginalPostSummary {
  id: string
  title: string | null
  content: string | null
  author_handle: string | null
  author_avatar_url: string | null
  images: string[] | null
  created_at: string
}

export interface WeightedPostListOptions extends PostListOptions {
  /**
   * 是否启用权重排序
   * 当 sort_by 为 'hot_score' 时，如果启用权重，会考虑作者权重
   */
  enable_weight?: boolean
  
  /**
   * 权重影响因子 (0-1)
   * 0: 完全不考虑权重
   * 1: 完全依赖权重
   * 默认 0.3，即权重占 30% 影响
   */
  weight_factor?: number
}

/**
 * 获取带权重增强的帖子列表
 * 在 hot_score 基础上融入用户权重，高权重用户的内容会获得额外排序优势
 */
export async function getWeightedPosts(
  supabase: SupabaseClient,
  options: WeightedPostListOptions = {}
): Promise<PostWithAuthor[]> {
  const {
    limit = 20,
    offset = 0,
    group_id,
    group_ids,
    author_handle,
    sort_by = 'created_at',
    sort_order = 'desc',
    enable_weight = false,
    weight_factor = 0.3,
  } = options

  // 如果不启用权重或不是按 hot_score 排序，使用原始查询
  if (!enable_weight || sort_by !== 'hot_score') {
    const { getPosts } = await import('./posts')
    return getPosts(supabase, {
      limit,
      offset,
      group_id,
      group_ids,
      author_handle,
      sort_by,
      sort_order,
    })
  }

  // 构建权重增强的查询
  const selectFields = `
    posts.id,
    posts.title,
    posts.content,
    posts.author_id,
    posts.author_handle,
    posts.group_id,
    posts.poll_enabled,
    posts.poll_id,
    posts.poll_bull,
    posts.poll_bear,
    posts.poll_wait,
    posts.like_count,
    posts.dislike_count,
    posts.comment_count,
    posts.bookmark_count,
    posts.repost_count,
    posts.view_count,
    posts.hot_score,
    posts.is_pinned,
    posts.images,
    posts.created_at,
    posts.updated_at,
    posts.original_post_id,
    groups.name as group_name,
    groups.name_en as group_name_en,
    user_profiles.weight as author_weight
  `

  let query = supabase
    .from('posts')
    .select(selectFields)
    // @ts-expect-error -- custom join not in Supabase types
    .join('user_profiles', { column: 'author_id', on: 'id', type: 'left' })
    .join('groups', { column: 'group_id', on: 'id', type: 'left' })
    .range(offset, offset + limit - 1)

  // 应用过滤条件
  if (group_id) {
    query = query.eq('posts.group_id', group_id)
  } else if (group_ids && group_ids.length > 0) {
    query = query.in('posts.group_id', group_ids)
  }

  if (author_handle) {
    const { data: authorProfile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('handle', author_handle)
      .maybeSingle()

    query = authorProfile?.id
      ? query.eq('posts.author_id', authorProfile.id)
      : query.eq('posts.author_handle', author_handle)
  }

  // 获取数据 - 暂时按 created_at 排序，后面会重新排序
  query = query.order('posts.created_at', { ascending: false })

  const { data: postsData, error } = await query
  if (error) throw error
  if (!postsData || postsData.length === 0) return []

  // 计算权重增强的排序分数
  const postsWithWeightedScore = (postsData as WeightedPostRow[]).map((post: WeightedPostRow) => {
    const baseScore = post.hot_score || 0
    const authorWeight = post.author_weight || 0
    
    // 权重增强算法：
    // weighted_score = hot_score * (1 - weight_factor) + (hot_score * weight_factor * author_weight / 100)
    // 这样权重高的用户的内容会获得额外的排序优势
    const weightMultiplier = 1 + (weight_factor * authorWeight / 100)
    const weightedScore = baseScore * weightMultiplier
    
    return {
      ...post,
      weighted_score: weightedScore,
      groups: post.group_name ? { 
        name: post.group_name, 
        name_en: post.group_name_en 
      } : null
    }
  })

  // 按权重增强分数排序
  postsWithWeightedScore.sort((a: WeightedPostRow, b: WeightedPostRow) => {
    const aScore = a.weighted_score ?? 0
    const bScore = b.weighted_score ?? 0
    if (sort_order === 'asc') {
      return aScore - bScore
    } else {
      return bScore - aScore
    }
  })

  // 转换为标准格式并获取作者信息
  const authorIds = [...new Set(postsWithWeightedScore.map((p) => p.author_id).filter(Boolean))]
  const originalPostIds = [...new Set(postsWithWeightedScore.map((p) => p.original_post_id).filter((id): id is string => !!id))]

  const [profilesResult, originalPostsResult] = await Promise.all([
    authorIds.length > 0
      ? supabase.from('user_profiles').select('id, handle, avatar_url, subscription_tier, show_pro_badge').in('id', authorIds)
      : Promise.resolve({ data: null }),
    originalPostIds.length > 0
      ? supabase.from('posts').select('id, title, content, author_id, author_handle, images, created_at').in('id', originalPostIds)
      : Promise.resolve({ data: null }),
  ])

  // 构建作者资料映射
  const authorProfileMap = new Map<string, AuthorProfile>()
  if (profilesResult.data) {
    for (const p of profilesResult.data) {
      authorProfileMap.set(p.id, {
        handle: p.handle,
        avatar_url: p.avatar_url,
        is_pro: p.subscription_tier === 'pro',
        show_pro_badge: p.show_pro_badge !== false,
      })
    }
  }

  // 处理原始帖子
  const originalPostMap = new Map<string, OriginalPostSummary>()
  if (originalPostsResult.data && originalPostsResult.data.length > 0) {
    const originalAuthorIds = [...new Set(originalPostsResult.data.map((p) => p.author_id).filter((id): id is string => typeof id === 'string' && !!id))]
    const missingIds = originalAuthorIds.filter(id => !authorProfileMap.has(id))

    if (missingIds.length > 0) {
      const { data: originalProfiles } = await supabase
        .from('user_profiles')
        .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
        .in('id', missingIds)

      if (originalProfiles) {
        for (const p of originalProfiles) {
          authorProfileMap.set(p.id, {
            handle: p.handle,
            avatar_url: p.avatar_url,
            is_pro: p.subscription_tier === 'pro',
            show_pro_badge: p.show_pro_badge !== false,
          })
        }
      }
    }

    for (const op of originalPostsResult.data) {
      const opProfile = authorProfileMap.get(op.author_id)
      originalPostMap.set(op.id, {
        id: op.id,
        title: op.title,
        content: op.content,
        author_handle: opProfile?.handle || op.author_handle,
        author_avatar_url: opProfile?.avatar_url || null,
        images: op.images || null,
        created_at: op.created_at,
      })
    }
  }

  // 转换为最终格式
  const result = postsWithWeightedScore.map((post: WeightedPostRow): PostWithAuthor => {
    const profile = authorProfileMap.get(post.author_id)
    
    return {
      id: post.id,
      title: post.title || '',
      content: post.content || '',
      author_id: post.author_id,
      author_handle: profile?.handle || post.author_handle || '',
      author_avatar_url: profile?.avatar_url ?? undefined,
      author_is_pro: profile?.is_pro ?? false,
      author_show_pro_badge: profile?.show_pro_badge !== false,
      group_id: post.group_id ?? undefined,
      group_name: post.group_name || undefined,
      group_name_en: post.group_name_en || undefined,
      poll_enabled: post.poll_enabled || false,
      poll_bull: post.poll_bull || 0,
      poll_bear: post.poll_bear || 0,
      poll_wait: post.poll_wait || 0,
      like_count: post.like_count || 0,
      dislike_count: post.dislike_count || 0,
      comment_count: post.comment_count || 0,
      bookmark_count: post.bookmark_count || 0,
      repost_count: post.repost_count || 0,
      view_count: post.view_count || 0,
      hot_score: post.hot_score || 0,
      is_pinned: post.is_pinned || false,
      images: post.images || null,
      created_at: post.created_at,
      updated_at: post.updated_at || undefined,
      original_post_id: post.original_post_id || null,
      original_post: post.original_post_id ? (originalPostMap.get(post.original_post_id) ?? null) : null,
    }
  })

  return result.slice(0, limit) // 确保返回正确的数量
}

/**
 * 获取权重增强的搜索结果
 * 在搜索结果中优先显示高权重用户的内容
 */
export async function getWeightedSearchResults(
  supabase: SupabaseClient,
  searchQuery: string,
  options: {
    limit?: number
    offset?: number
    enable_weight?: boolean
    weight_factor?: number
  } = {}
): Promise<PostWithAuthor[]> {
  const {
    limit = 20,
    offset = 0,
    enable_weight = true,
    weight_factor = 0.4, // 搜索中权重影响更大
  } = options

  if (!enable_weight) {
    // 标准搜索查询
    const { data, error } = await supabase
      .from('posts')
      .select(`
        id, title, content, author_id, author_handle, group_id,
        poll_enabled, poll_id, poll_bull, poll_bear, poll_wait,
        like_count, dislike_count, comment_count, bookmark_count,
        repost_count, view_count, hot_score, is_pinned, images,
        created_at, updated_at, original_post_id, groups(name, name_en)
      `)
      .or(`title.ilike.%${searchQuery}%, content.ilike.%${searchQuery}%`)
      .order('hot_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error
    return data || []
  }

  // 权重增强的搜索查询
  const { data: searchResults, error } = await supabase
    .rpc('search_posts_with_weight', {
      search_query: searchQuery,
      result_limit: Math.max(limit * 2, 50), // 获取更多结果用于重排序
      result_offset: offset,
      weight_factor: weight_factor
    })

  if (error) {
    logger.error('Weighted search RPC failed, falling back to standard search:', error)
    
    // 回退到标准搜索
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('posts')
      .select(`
        id, title, content, author_id, author_handle, group_id,
        poll_enabled, poll_id, poll_bull, poll_bear, poll_wait,
        like_count, dislike_count, comment_count, bookmark_count,
        repost_count, view_count, hot_score, is_pinned, images,
        created_at, updated_at, original_post_id, groups(name, name_en)
      `)
      .or(`title.ilike.%${searchQuery}%, content.ilike.%${searchQuery}%`)
      .order('hot_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fallbackError) throw fallbackError
    return fallbackData || []
  }

  return (searchResults || []).slice(0, limit)
}