/**
 * Content Recommendation Algorithm
 *
 * Provides personalized post and trader recommendations based on:
 * - User's followed traders
 * - User's interaction history (likes, comments, bookmarks)
 * - Content similarity
 * - Trending/hot content
 */

import type { SupabaseClient } from '@supabase/supabase-js'

interface UserProfile {
  userId: string
  followedTraders: string[]
  likedPostIds: string[]
  bookmarkedPostIds: string[]
  commentedPostIds: string[]
  joinedGroupIds: string[]
}

interface RecommendationScore {
  id: string
  score: number
  reasons: string[]
}

interface RecommendationOptions {
  limit?: number
  excludeIds?: string[]
  minScore?: number
}

/**
 * Get personalized post recommendations for a user.
 */
export async function getPostRecommendations(
  supabase: SupabaseClient,
  userId: string,
  options: RecommendationOptions = {}
): Promise<RecommendationScore[]> {
  const { limit = 20, excludeIds = [], minScore = 0 } = options

  // Get user profile data
  const profile = await getUserProfile(supabase, userId)

  // Get candidate posts (recent posts not by user)
  const { data: candidates } = await supabase
    .from('posts')
    .select(`
      id,
      author_handle,
      group_id,
      hot_score,
      like_count,
      comment_count,
      created_at,
      trader_handles
    `)
    .neq('author_id', userId)
    .order('created_at', { ascending: false })
    .limit(200)

  if (!candidates || candidates.length === 0) {
    return []
  }

  // Score each candidate
  const scored: RecommendationScore[] = []

  for (const post of candidates) {
    if (excludeIds.includes(post.id)) continue

    const { score, reasons } = calculatePostScore(post, profile)

    if (score >= minScore) {
      scored.push({ id: post.id, score, reasons })
    }
  }

  // Sort by score and return top N
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Get similar traders based on a given trader's characteristics.
 */
export async function getSimilarTraders(
  supabase: SupabaseClient,
  traderHandle: string,
  options: RecommendationOptions = {}
): Promise<RecommendationScore[]> {
  const { limit = 10, excludeIds = [] } = options

  // Get the source trader's data
  const { data: sourceTrader } = await supabase
    .from('traders')
    .select('handle, source, roi, win_rate, max_drawdown, arena_score, trading_style')
    .eq('handle', traderHandle)
    .single()

  if (!sourceTrader) return []

  // Get candidate traders
  const { data: candidates } = await supabase
    .from('traders')
    .select('handle, source, roi, win_rate, max_drawdown, arena_score, trading_style')
    .neq('handle', traderHandle)
    .order('arena_score', { ascending: false })
    .limit(100)

  if (!candidates) return []

  // Score each candidate based on similarity
  const scored: RecommendationScore[] = []

  for (const trader of candidates) {
    if (excludeIds.includes(trader.handle)) continue

    const { score, reasons } = calculateTraderSimilarity(sourceTrader, trader)

    if (score > 0) {
      scored.push({ id: trader.handle, score, reasons })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/**
 * Get trending content (hot posts in the last 24 hours).
 */
export async function getTrendingPosts(
  supabase: SupabaseClient,
  options: RecommendationOptions = {}
): Promise<RecommendationScore[]> {
  const { limit = 20 } = options

  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { data: posts } = await supabase
    .from('posts')
    .select('id, hot_score, like_count, comment_count, repost_count')
    .gte('created_at', oneDayAgo)
    .order('hot_score', { ascending: false })
    .limit(limit)

  if (!posts) return []

  return posts.map((post) => ({
    id: post.id,
    score: post.hot_score || 0,
    reasons: [
      `${post.like_count} likes`,
      `${post.comment_count} comments`,
      post.repost_count > 0 ? `${post.repost_count} reposts` : '',
    ].filter(Boolean),
  }))
}

// ── Helper Functions ──

async function getUserProfile(
  supabase: SupabaseClient,
  userId: string
): Promise<UserProfile> {
  const [followsResult, likesResult, bookmarksResult, commentsResult, groupsResult] = await Promise.all([
    // Followed traders
    supabase
      .from('trader_follows')
      .select('trader_handle')
      .eq('user_id', userId),
    // Liked posts
    supabase
      .from('post_likes')
      .select('post_id')
      .eq('user_id', userId)
      .limit(100),
    // Bookmarked posts
    supabase
      .from('post_bookmarks')
      .select('post_id')
      .eq('user_id', userId)
      .limit(100),
    // Commented posts
    supabase
      .from('post_comments')
      .select('post_id')
      .eq('author_id', userId)
      .limit(100),
    // Joined groups
    supabase
      .from('group_members')
      .select('group_id')
      .eq('user_id', userId),
  ])

  return {
    userId,
    followedTraders: (followsResult.data || []).map((f) => f.trader_handle),
    likedPostIds: (likesResult.data || []).map((l) => l.post_id),
    bookmarkedPostIds: (bookmarksResult.data || []).map((b) => b.post_id),
    commentedPostIds: (commentsResult.data || []).map((c) => c.post_id),
    joinedGroupIds: (groupsResult.data || []).map((g) => g.group_id),
  }
}

function calculatePostScore(
  post: {
    id: string
    author_handle?: string
    group_id?: string | null
    hot_score?: number
    like_count?: number
    comment_count?: number
    trader_handles?: string[]
  },
  profile: UserProfile
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // Base score from hot_score
  if (post.hot_score) {
    score += Math.min(post.hot_score * 0.5, 50) // Cap at 50 points
  }

  // Boost for posts from followed traders
  if (post.trader_handles) {
    const matchedTraders = post.trader_handles.filter((t) =>
      profile.followedTraders.includes(t)
    )
    if (matchedTraders.length > 0) {
      score += 30 * matchedTraders.length
      reasons.push(`From followed trader: ${matchedTraders[0]}`)
    }
  }

  // Boost for posts in joined groups
  if (post.group_id && profile.joinedGroupIds.includes(post.group_id)) {
    score += 20
    reasons.push('From your group')
  }

  // Engagement signals
  if (post.like_count && post.like_count > 10) {
    score += Math.min(post.like_count * 0.5, 20)
    reasons.push(`${post.like_count} likes`)
  }

  if (post.comment_count && post.comment_count > 5) {
    score += Math.min(post.comment_count * 1, 15)
    reasons.push(`${post.comment_count} comments`)
  }

  // Penalize already interacted posts
  if (profile.likedPostIds.includes(post.id)) {
    score -= 50
  }
  if (profile.bookmarkedPostIds.includes(post.id)) {
    score -= 50
  }

  return { score, reasons }
}

function calculateTraderSimilarity(
  source: {
    roi?: number
    win_rate?: number
    max_drawdown?: number
    source?: string
    trading_style?: string
  },
  target: {
    handle: string
    roi?: number
    win_rate?: number
    max_drawdown?: number
    source?: string
    trading_style?: string
  }
): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // Same exchange
  if (source.source && target.source && source.source === target.source) {
    score += 20
    reasons.push('Same exchange')
  }

  // Similar ROI (within 30%)
  if (source.roi && target.roi) {
    const roiDiff = Math.abs(source.roi - target.roi)
    const roiSimilarity = Math.max(0, 1 - roiDiff / Math.max(Math.abs(source.roi), 1))
    if (roiSimilarity > 0.7) {
      score += 30 * roiSimilarity
      reasons.push('Similar ROI')
    }
  }

  // Similar win rate (within 15%)
  if (source.win_rate && target.win_rate) {
    const wrDiff = Math.abs(source.win_rate - target.win_rate)
    if (wrDiff < 15) {
      score += 20 * (1 - wrDiff / 15)
      reasons.push('Similar win rate')
    }
  }

  // Similar risk profile (max drawdown)
  if (source.max_drawdown && target.max_drawdown) {
    const ddDiff = Math.abs(Math.abs(source.max_drawdown) - Math.abs(target.max_drawdown))
    if (ddDiff < 10) {
      score += 15 * (1 - ddDiff / 10)
      reasons.push('Similar risk profile')
    }
  }

  // Same trading style
  if (source.trading_style && target.trading_style && source.trading_style === target.trading_style) {
    score += 15
    reasons.push('Same trading style')
  }

  return { score, reasons }
}
