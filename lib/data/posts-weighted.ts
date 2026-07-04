/**
 * 用户权重增强的帖子数据层
 * 在现有排序基础上融入用户权重系统
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { PostWithAuthor, PostListOptions } from './posts'
import { logger } from '@/lib/logger'

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

  const { getPosts } = await import('./posts')

  // 如果不启用权重或不是按 hot_score 排序，使用原始查询
  if (!enable_weight || sort_by !== 'hot_score') {
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

  // 权重增强路径（2026-07-03 重写）：
  // 旧实现调用了 supabase-js 上并不存在的 .join() 方法（用 @ts-expect-error
  // 压掉了编译错），任何 ?enable_weight=true&sort_by=hot_score 请求都会
  // TypeError → 500。现改为：标准 getPosts 拿到当页 → 批量查作者 weight →
  // 页内按 hot_score×(1 + weight_factor×weight/100) 重排。语义与原意一致
  // （旧代码同样只在取回的页内重排序）。
  const posts = await getPosts(supabase, {
    limit,
    offset,
    group_id,
    group_ids,
    author_handle,
    sort_by: 'hot_score',
    sort_order,
  })
  if (posts.length === 0) return []

  // 批量取作者权重；失败时优雅回退为未加权顺序（不让加权崩掉 feed）
  const weightByAuthor = new Map<string, number>()
  const authorIds = [...new Set(posts.map((p) => p.author_id).filter(Boolean))]
  if (authorIds.length > 0) {
    const { data: profiles, error: weightError } = await supabase
      .from('user_profiles')
      .select('id, weight')
      .in('id', authorIds)
    if (weightError) {
      logger.warn('[posts-weighted] weight lookup failed, serving unweighted order:', weightError)
      return posts
    }
    for (const p of (profiles ?? []) as Array<{ id: string; weight: number | null }>) {
      weightByAuthor.set(p.id, p.weight ?? 0)
    }
  }

  const weightedScore = (p: PostWithAuthor): number => {
    const base = p.hot_score || 0
    const authorWeight = weightByAuthor.get(p.author_id) ?? 0
    return base * (1 + (weight_factor * authorWeight) / 100)
  }

  return [...posts].sort((a, b) =>
    sort_order === 'asc' ? weightedScore(a) - weightedScore(b) : weightedScore(b) - weightedScore(a)
  )
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
      .select(
        `
        id, title, content, author_id, author_handle, group_id,
        poll_enabled, poll_id, poll_bull, poll_bear, poll_wait,
        like_count, dislike_count, comment_count, bookmark_count,
        repost_count, view_count, hot_score, is_pinned, images,
        created_at, updated_at, original_post_id, groups(name, name_en)
      `
      )
      .or(
        `title.ilike.%${searchQuery.replace(/[,.()\[\]\\%_]/g, '')}%, content.ilike.%${searchQuery.replace(/[,.()\[\]\\%_]/g, '')}%`
      )
      .order('hot_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (error) throw error
    return data || []
  }

  // 权重增强的搜索查询
  const { data: searchResults, error } = await supabase.rpc('search_posts_with_weight', {
    search_query: searchQuery,
    result_limit: Math.max(limit * 2, 50), // 获取更多结果用于重排序
    result_offset: offset,
    weight_factor: weight_factor,
  })

  if (error) {
    logger.error('Weighted search RPC failed, falling back to standard search:', error)

    // 回退到标准搜索
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('posts')
      .select(
        `
        id, title, content, author_id, author_handle, group_id,
        poll_enabled, poll_id, poll_bull, poll_bear, poll_wait,
        like_count, dislike_count, comment_count, bookmark_count,
        repost_count, view_count, hot_score, is_pinned, images,
        created_at, updated_at, original_post_id, groups(name, name_en)
      `
      )
      .or(
        `title.ilike.%${searchQuery.replace(/[,.()\[\]\\%_]/g, '')}%, content.ilike.%${searchQuery.replace(/[,.()\[\]\\%_]/g, '')}%`
      )
      .order('hot_score', { ascending: false })
      .range(offset, offset + limit - 1)

    if (fallbackError) throw fallbackError
    return fallbackData || []
  }

  return (searchResults || []).slice(0, limit)
}
