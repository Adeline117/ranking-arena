/**
 * 评价数据缓存层
 * 为热门交易员评价页面提供缓存，减少数据库压力
 */

import { SupabaseClient } from '@supabase/supabase-js'
import * as cache from '@/lib/cache'
import {
  getTraderReviews,
  getTraderCommunityScore,
  type TraderReview,
  type TraderCommunityScore,
  type ReviewListOptions,
} from './reviews'

// 缓存 TTL 配置
const REVIEWS_CACHE_TTL = 300      // 评价列表：5 分钟
const SCORE_CACHE_TTL = 600        // 社区评分：10 分钟
const STATS_CACHE_TTL = 900        // 统计数据：15 分钟

/**
 * 获取缓存的交易员评价列表
 */
export async function getCachedTraderReviews(
  supabase: SupabaseClient,
  traderId: string,
  source: string,
  options: ReviewListOptions = {},
  currentUserId?: string
): Promise<TraderReview[]> {
  // 如果有当前用户，需要获取个性化的投票状态，不能完全缓存
  // 但基础评价数据可以缓存
  const cacheKey = `reviews:${traderId}:${source}:${options.sort_by || 'created_at'}:${options.offset || 0}:${options.limit || 20}`
  
  // 先尝试从缓存获取基础数据
  const cachedReviews = await cache.get<TraderReview[]>(cacheKey)
  
  if (cachedReviews && !currentUserId) {
    // 无用户登录，直接返回缓存
    return cachedReviews
  }
  
  if (cachedReviews && currentUserId) {
    // 有用户登录，需要补充投票状态
    const reviewIds = cachedReviews.map(r => r.id)
    const { data: votes } = await supabase
      .from('review_votes')
      .select('review_id, vote_type')
      .eq('user_id', currentUserId)
      .in('review_id', reviewIds)

    const userVotes = new Map<string, 'helpful' | 'unhelpful'>()
    votes?.forEach((v) => {
      userVotes.set(v.review_id, v.vote_type as 'helpful' | 'unhelpful')
    })

    return cachedReviews.map(review => ({
      ...review,
      user_vote: userVotes.get(review.id) || null,
    }))
  }
  
  // 缓存未命中，从数据库获取
  const reviews = await getTraderReviews(supabase, traderId, source, options, currentUserId)
  
  // 缓存基础数据（不含用户投票状态）
  const reviewsForCache = reviews.map(r => ({ ...r, user_vote: null }))
  await cache.set(cacheKey, reviewsForCache, { 
    ttl: REVIEWS_CACHE_TTL,
    tags: ['reviews', `trader:${traderId}`]
  })
  
  return reviews
}

/**
 * 获取缓存的交易员社区评分
 */
export async function getCachedCommunityScore(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<TraderCommunityScore | null> {
  const cacheKey = `community_score:${traderId}:${source}`
  
  return cache.getOrSet(
    cacheKey,
    async () => {
      return getTraderCommunityScore(supabase, traderId, source)
    },
    { 
      ttl: SCORE_CACHE_TTL,
      tags: ['reviews', `trader:${traderId}`]
    }
  )
}

/**
 * 获取热门交易员列表（按评价数量排序）
 */
export async function getCachedPopularTraders(
  supabase: SupabaseClient,
  limit: number = 20
): Promise<TraderCommunityScore[]> {
  const cacheKey = `popular_traders:${limit}`
  
  return cache.getOrSet(
    cacheKey,
    async () => {
      const { data, error } = await supabase
        .from('trader_community_scores')
        .select('*')
        .order('review_count', { ascending: false })
        .limit(limit)
      
      if (error) {
        console.error('[cached-reviews] 获取热门交易员失败:', error)
        throw error
      }
      
      return data || []
    },
    { 
      ttl: STATS_CACHE_TTL,
      tags: ['reviews']
    }
  )
}

/**
 * 失效特定交易员的评价缓存
 * 在创建/更新/删除评价后调用
 */
export async function invalidateReviewCache(
  traderId: string,
  _source: string
): Promise<void> {
  try {
    // 失效该交易员相关的所有缓存
    await cache.delByTag(`trader:${traderId}`)
    
    // 也失效热门交易员列表缓存
    await cache.del('popular_traders:20')
    await cache.del('popular_traders:50')
  } catch (error) {
    console.error('[cached-reviews] 失效缓存失败:', error)
  }
}

/**
 * 批量获取多个交易员的社区评分
 * 适用于列表页面展示
 */
export async function getBatchCommunityScores(
  supabase: SupabaseClient,
  traders: Array<{ trader_id: string; source: string }>
): Promise<Map<string, TraderCommunityScore>> {
  const result = new Map<string, TraderCommunityScore>()
  
  if (traders.length === 0) return result
  
  // 尝试从缓存批量获取
  const cacheKeys = traders.map(t => `community_score:${t.trader_id}:${t.source}`)
  const cachedValues = await cache.mget<TraderCommunityScore>(cacheKeys)
  
  const missingTraders: Array<{ trader_id: string; source: string }> = []
  
  traders.forEach((trader, index) => {
    const cached = cachedValues[index]
    if (cached) {
      result.set(`${trader.trader_id}:${trader.source}`, cached)
    } else {
      missingTraders.push(trader)
    }
  })
  
  // 批量查询缺失的数据
  if (missingTraders.length > 0) {
    // 按 source 分组查询
    const bySource = new Map<string, string[]>()
    missingTraders.forEach(t => {
      if (!bySource.has(t.source)) {
        bySource.set(t.source, [])
      }
      bySource.get(t.source)!.push(t.trader_id)
    })
    
    for (const [source, traderIds] of bySource) {
      const { data: scores } = await supabase
        .from('trader_community_scores')
        .select('*')
        .eq('source', source)
        .in('trader_id', traderIds)
      
      if (scores) {
        // 设置结果并缓存
        for (const score of scores) {
          const key = `${score.trader_id}:${score.source}`
          result.set(key, score)
          
          // 设置缓存
          await cache.set(`community_score:${score.trader_id}:${score.source}`, score, { 
            ttl: SCORE_CACHE_TTL,
            tags: ['reviews', `trader:${score.trader_id}`]
          })
        }
      }
    }
  }
  
  return result
}
