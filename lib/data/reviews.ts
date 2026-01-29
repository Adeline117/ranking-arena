/**
 * 交易员评论/评价数据层
 * 独立于帖子评论系统，用于交易员 profile 页面的用户评价
 */

import { SupabaseClient } from '@supabase/supabase-js'

export interface Review {
  id: string
  trader_id: string
  user_id: string
  rating: number // 1-5
  content: string
  like_count: number
  created_at: string
  updated_at: string
  author_handle?: string
  author_avatar_url?: string
  author_is_pro?: boolean
  author_show_pro_badge?: boolean
  user_liked?: boolean
}

export interface ReviewSummary {
  avg_rating: number
  review_count: number
  rating_distribution: Record<number, number> // { 1: 2, 2: 0, 3: 5, ... }
}

export interface CreateReviewInput {
  trader_id: string
  rating: number
  content: string
}

interface ReviewRow {
  id: string
  trader_id: string
  user_id: string
  rating: number
  content: string
  like_count?: number
  created_at: string
  updated_at: string
}

interface AuthorProfile {
  handle: string
  avatar_url: string | null
  is_pro: boolean
  show_pro_badge: boolean
}

function toReview(
  row: ReviewRow,
  profile?: AuthorProfile,
  userLiked = false,
): Review {
  return {
    id: row.id,
    trader_id: row.trader_id,
    user_id: row.user_id,
    rating: row.rating,
    content: row.content,
    like_count: row.like_count || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
    author_handle: profile?.handle,
    author_avatar_url: profile?.avatar_url ?? undefined,
    author_is_pro: profile?.is_pro ?? false,
    author_show_pro_badge: profile?.show_pro_badge !== false,
    user_liked: userLiked,
  }
}

function buildProfileMap(
  profiles: Array<{
    id: string
    handle: string
    avatar_url: string | null
    subscription_tier?: string | null
    show_pro_badge?: boolean | null
  }>
): Map<string, AuthorProfile> {
  const map = new Map<string, AuthorProfile>()
  for (const p of profiles) {
    map.set(p.id, {
      handle: p.handle,
      avatar_url: p.avatar_url,
      is_pro: p.subscription_tier === 'pro',
      show_pro_badge: p.show_pro_badge !== false,
    })
  }
  return map
}

/**
 * 获取交易员的评价列表
 */
export async function getTraderReviews(
  supabase: SupabaseClient,
  traderId: string,
  options: { limit?: number; offset?: number; userId?: string; sort?: 'newest' | 'top' } = {}
): Promise<Review[]> {
  const { limit = 20, offset = 0, userId, sort = 'newest' } = options

  let query = supabase
    .from('trader_reviews')
    .select('*')
    .eq('trader_id', traderId)

  if (sort === 'top') {
    query = query.order('like_count', { ascending: false }).order('created_at', { ascending: false })
  } else {
    query = query.order('created_at', { ascending: false })
  }

  query = query.range(offset, offset + limit - 1)

  const { data: reviews, error } = await query
  if (error) throw error
  if (!reviews || reviews.length === 0) return []

  const userIds = [...new Set(reviews.map((r: ReviewRow) => r.user_id))]
  const reviewIds = reviews.map((r: ReviewRow) => r.id)

  const [profilesResult, likesResult] = await Promise.all([
    supabase
      .from('user_profiles')
      .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
      .in('id', userIds),
    userId
      ? supabase.from('review_likes').select('review_id').eq('user_id', userId).in('review_id', reviewIds)
      : Promise.resolve({ data: null }),
  ])

  const profileMap = profilesResult.data ? buildProfileMap(profilesResult.data) : new Map()
  const userLikedSet = new Set(
    likesResult.data?.map((like: { review_id: string }) => like.review_id) || []
  )

  return reviews.map((r: ReviewRow) =>
    toReview(r, profileMap.get(r.user_id), userLikedSet.has(r.id))
  )
}

/**
 * 获取评价摘要（平均分 + 分布）
 */
export async function getReviewSummary(
  supabase: SupabaseClient,
  traderId: string,
): Promise<ReviewSummary> {
  const { data, error } = await supabase
    .from('trader_reviews')
    .select('rating')
    .eq('trader_id', traderId)

  if (error) throw error

  const reviews = data || []
  const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  let total = 0

  for (const r of reviews) {
    distribution[r.rating] = (distribution[r.rating] || 0) + 1
    total += r.rating
  }

  return {
    avg_rating: reviews.length > 0 ? total / reviews.length : 0,
    review_count: reviews.length,
    rating_distribution: distribution,
  }
}

/**
 * 创建评价
 */
export async function createReview(
  supabase: SupabaseClient,
  userId: string,
  input: CreateReviewInput,
): Promise<Review> {
  // 检查是否已有评价
  const { data: existing } = await supabase
    .from('trader_reviews')
    .select('id')
    .eq('trader_id', input.trader_id)
    .eq('user_id', userId)
    .maybeSingle()

  if (existing) {
    throw new Error('ALREADY_REVIEWED')
  }

  const { data, error } = await supabase
    .from('trader_reviews')
    .insert({
      trader_id: input.trader_id,
      user_id: userId,
      rating: input.rating,
      content: input.content,
    })
    .select()
    .single()

  if (error) throw error

  const { data: profile } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url, subscription_tier, show_pro_badge')
    .eq('id', userId)
    .maybeSingle()

  const profileMap = profile ? buildProfileMap([profile]) : new Map()
  return toReview(data, profileMap.get(userId))
}

/**
 * 更新评价
 */
export async function updateReview(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
  input: { rating?: number; content?: string },
): Promise<Review> {
  const updateData: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.rating !== undefined) updateData.rating = input.rating
  if (input.content !== undefined) updateData.content = input.content

  const { data, error } = await supabase
    .from('trader_reviews')
    .update(updateData)
    .eq('id', reviewId)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) throw error
  return toReview(data)
}

/**
 * 删除评价
 */
export async function deleteReview(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('trader_reviews')
    .delete()
    .eq('id', reviewId)
    .eq('user_id', userId)

  if (error) throw error
}
