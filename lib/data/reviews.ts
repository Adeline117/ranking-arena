/**
 * 交易员评价数据层
 * 提供评价的 CRUD 操作
 */

import { SupabaseClient } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

export interface TraderReview {
  id: string
  trader_id: string
  source: string
  user_id: string
  overall_rating: number
  stability_rating: number | null
  drawdown_rating: number | null
  review_text: string | null
  follow_duration_days: number | null
  profit_loss_percent: number | null
  would_recommend: boolean | null
  screenshot_url: string | null
  verified: boolean
  helpful_count: number
  unhelpful_count: number
  created_at: string
  updated_at: string
  // 关联数据
  author_handle?: string
  author_avatar_url?: string
  user_vote?: 'helpful' | 'unhelpful' | null
}

export interface TraderCommunityScore {
  trader_id: string
  source: string
  avg_rating: number
  avg_stability: number | null
  avg_drawdown: number | null
  review_count: number
  recommend_rate: number
  avg_follow_days: number | null
  avg_profit_loss: number | null
  verified_reviews: number
}

export interface CreateReviewInput {
  trader_id: string
  source: string
  overall_rating: number
  stability_rating?: number
  drawdown_rating?: number
  review_text?: string
  follow_duration_days?: number
  profit_loss_percent?: number
  would_recommend?: boolean
  screenshot_url?: string
}

export interface UpdateReviewInput {
  overall_rating?: number
  stability_rating?: number
  drawdown_rating?: number
  review_text?: string
  follow_duration_days?: number
  profit_loss_percent?: number
  would_recommend?: boolean
  screenshot_url?: string
}

export interface ReviewListOptions {
  limit?: number
  offset?: number
  sort_by?: 'created_at' | 'helpful_count' | 'overall_rating'
  sort_order?: 'asc' | 'desc'
  verified_only?: boolean
}

// ============================================
// 查询函数
// ============================================

/**
 * 获取交易员的社区评分
 */
export async function getTraderCommunityScore(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<TraderCommunityScore | null> {
  const { data, error } = await supabase
    .from('trader_community_scores')
    .select('*')
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    console.error('[reviews] 获取社区评分失败:', error)
    throw error
  }

  return data
}

/**
 * 获取交易员的评价列表
 */
export async function getTraderReviews(
  supabase: SupabaseClient,
  traderId: string,
  source: string,
  options: ReviewListOptions = {},
  currentUserId?: string
): Promise<TraderReview[]> {
  const {
    limit = 20,
    offset = 0,
    sort_by = 'created_at',
    sort_order = 'desc',
    verified_only = false,
  } = options

  let query = supabase
    .from('trader_reviews')
    .select('*')
    .eq('trader_id', traderId)
    .eq('source', source)
    .order(sort_by, { ascending: sort_order === 'asc' })
    .range(offset, offset + limit - 1)

  if (verified_only) {
    query = query.eq('verified', true)
  }

  const { data: reviews, error } = await query

  if (error) {
    console.error('[reviews] 获取评价列表失败:', error)
    throw error
  }

  if (!reviews || reviews.length === 0) return []

  // 获取评价作者信息
  const userIds = [...new Set(reviews.map((r) => r.user_id))]
  const { data: profiles } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .in('id', userIds)

  const profileMap = new Map<string, { handle: string; avatar_url: string | null }>()
  profiles?.forEach((p) => {
    profileMap.set(p.id, { handle: p.handle || '匿名用户', avatar_url: p.avatar_url })
  })

  // 如果有当前用户，获取其投票状态
  let userVotes = new Map<string, 'helpful' | 'unhelpful'>()
  if (currentUserId) {
    const reviewIds = reviews.map((r) => r.id)
    const { data: votes } = await supabase
      .from('review_votes')
      .select('review_id, vote_type')
      .eq('user_id', currentUserId)
      .in('review_id', reviewIds)

    votes?.forEach((v) => {
      userVotes.set(v.review_id, v.vote_type as 'helpful' | 'unhelpful')
    })
  }

  // 组装返回数据
  return reviews.map((review) => {
    const profile = profileMap.get(review.user_id)
    return {
      ...review,
      author_handle: profile?.handle || '匿名用户',
      author_avatar_url: profile?.avatar_url || null,
      user_vote: userVotes.get(review.id) || null,
    }
  })
}

/**
 * 获取用户的评价（检查是否已评价）
 */
export async function getUserReview(
  supabase: SupabaseClient,
  userId: string,
  traderId: string,
  source: string
): Promise<TraderReview | null> {
  const { data, error } = await supabase
    .from('trader_reviews')
    .select('*')
    .eq('user_id', userId)
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    console.error('[reviews] 获取用户评价失败:', error)
    throw error
  }

  return data
}

/**
 * 获取用户的所有评价
 */
export async function getUserReviews(
  supabase: SupabaseClient,
  userId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<TraderReview[]> {
  const { limit = 20, offset = 0 } = options

  const { data, error } = await supabase
    .from('trader_reviews')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    console.error('[reviews] 获取用户评价列表失败:', error)
    throw error
  }

  return data || []
}

// ============================================
// 写入函数
// ============================================

/**
 * 创建评价
 */
export async function createReview(
  supabase: SupabaseClient,
  userId: string,
  input: CreateReviewInput
): Promise<TraderReview> {
  const { data, error } = await supabase
    .from('trader_reviews')
    .insert({
      user_id: userId,
      trader_id: input.trader_id,
      source: input.source,
      overall_rating: input.overall_rating,
      stability_rating: input.stability_rating,
      drawdown_rating: input.drawdown_rating,
      review_text: input.review_text,
      follow_duration_days: input.follow_duration_days,
      profit_loss_percent: input.profit_loss_percent,
      would_recommend: input.would_recommend,
      screenshot_url: input.screenshot_url,
    })
    .select()
    .single()

  if (error) {
    console.error('[reviews] 创建评价失败:', error)
    throw error
  }

  return data
}

/**
 * 更新评价
 */
export async function updateReview(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
  input: UpdateReviewInput
): Promise<TraderReview> {
  const { data, error } = await supabase
    .from('trader_reviews')
    .update({
      overall_rating: input.overall_rating,
      stability_rating: input.stability_rating,
      drawdown_rating: input.drawdown_rating,
      review_text: input.review_text,
      follow_duration_days: input.follow_duration_days,
      profit_loss_percent: input.profit_loss_percent,
      would_recommend: input.would_recommend,
      screenshot_url: input.screenshot_url,
    })
    .eq('id', reviewId)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    console.error('[reviews] 更新评价失败:', error)
    throw error
  }

  return data
}

/**
 * 删除评价
 */
export async function deleteReview(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('trader_reviews')
    .delete()
    .eq('id', reviewId)
    .eq('user_id', userId)

  if (error) {
    console.error('[reviews] 删除评价失败:', error)
    throw error
  }
}

/**
 * 投票（有帮助/无帮助）
 */
export async function voteReview(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string,
  voteType: 'helpful' | 'unhelpful'
): Promise<void> {
  // 使用 upsert 来处理新增或更新
  const { error } = await supabase
    .from('review_votes')
    .upsert(
      {
        review_id: reviewId,
        user_id: userId,
        vote_type: voteType,
      },
      {
        onConflict: 'review_id,user_id',
      }
    )

  if (error) {
    console.error('[reviews] 投票失败:', error)
    throw error
  }
}

/**
 * 取消投票
 */
export async function removeVote(
  supabase: SupabaseClient,
  reviewId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('review_votes')
    .delete()
    .eq('review_id', reviewId)
    .eq('user_id', userId)

  if (error) {
    console.error('[reviews] 取消投票失败:', error)
    throw error
  }
}

/**
 * 验证评价（管理员功能）
 */
export async function verifyReview(
  supabase: SupabaseClient,
  reviewId: string,
  verified: boolean
): Promise<void> {
  const { error } = await supabase
    .from('trader_reviews')
    .update({ verified })
    .eq('id', reviewId)

  if (error) {
    console.error('[reviews] 验证评价失败:', error)
    throw error
  }
}

// ============================================
// 统计函数
// ============================================

/**
 * 获取交易员评价统计
 */
export async function getReviewStats(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<{
  total: number
  averageRating: number
  ratingDistribution: Record<number, number>
  recommendRate: number
  verifiedCount: number
}> {
  // 获取所有评价
  const { data: reviews, error } = await supabase
    .from('trader_reviews')
    .select('overall_rating, would_recommend, verified')
    .eq('trader_id', traderId)
    .eq('source', source)

  if (error) {
    console.error('[reviews] 获取评价统计失败:', error)
    throw error
  }

  if (!reviews || reviews.length === 0) {
    return {
      total: 0,
      averageRating: 0,
      ratingDistribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
      recommendRate: 0,
      verifiedCount: 0,
    }
  }

  const total = reviews.length
  const averageRating = reviews.reduce((sum, r) => sum + r.overall_rating, 0) / total
  
  const ratingDistribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }
  reviews.forEach((r) => {
    ratingDistribution[r.overall_rating]++
  })

  const recommendCount = reviews.filter((r) => r.would_recommend === true).length
  const recommendTotal = reviews.filter((r) => r.would_recommend !== null).length
  const recommendRate = recommendTotal > 0 ? recommendCount / recommendTotal : 0

  const verifiedCount = reviews.filter((r) => r.verified).length

  return {
    total,
    averageRating: Math.round(averageRating * 100) / 100,
    ratingDistribution,
    recommendRate: Math.round(recommendRate * 100) / 100,
    verifiedCount,
  }
}
