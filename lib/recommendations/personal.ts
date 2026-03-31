/**
 * Personalized Recommendation Engine
 *
 * Rule-based personalization using:
 * - Traders similar to those the user follows (same exchange, similar ROI)
 * - User's preferred exchanges (inferred from follows)
 * - Arena score proximity
 */

import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('personal-rec')

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonalRecommendation {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
  reason: 'similar_to_follow' | 'preferred_exchange' | 'top_performer'
  reason_detail: string
}

interface FollowedTrader {
  source: string
  source_trader_id: string
  arena_score: number | null
  roi: number | null
}

interface RankRow {
  source: string
  source_trader_id: string
  handle: string | null
  avatar_url: string | null
  arena_score: number | null
  roi: number | null
  pnl: number | null
  win_rate: number | null
}

// ---------------------------------------------------------------------------
// Supabase helper
// ---------------------------------------------------------------------------

function getSupabase() {
  return getSupabaseAdmin()
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

/**
 * Generate personalized recommendations for a user.
 */
export async function getPersonalRecommendations(
  userId: string,
  limit = 20,
): Promise<PersonalRecommendation[]> {
  const supabase = getSupabase()

  // 1. Get user's followed traders (via user_follows -> trader mapping)
  const followedTraders = await getUserFollowedTraders(supabase, userId)

  if (followedTraders.length === 0) {
    // Fallback: return top performers across exchanges
    return getTopPerformersFallback(supabase, limit)
  }

  // 2. Identify preferred exchanges
  const exchangeCounts = new Map<string, number>()
  for (const t of followedTraders) {
    exchangeCounts.set(t.source, (exchangeCounts.get(t.source) || 0) + 1)
  }
  const preferredExchanges = [...exchangeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([ex]) => ex)

  // 3. Build exclusion set (already followed)
  const followedSet = new Set(
    followedTraders.map(t => `${t.source}:${t.source_trader_id}`),
  )

  const recommendations: PersonalRecommendation[] = []

  // 4. Find similar traders (same exchange, similar ROI range)
  for (const trader of followedTraders.slice(0, 10)) {
    const similar = await findSimilarTraders(supabase, trader, 5)
    for (const s of similar) {
      const key = `${s.source}:${s.source_trader_id}`
      if (!followedSet.has(key)) {
        followedSet.add(key) // deduplicate
        recommendations.push({
          ...s,
          reason: 'similar_to_follow',
          reason_detail: `Similar to ${trader.source_trader_id} on ${trader.source}`,
        })
      }
    }
  }

  // 5. Top performers from preferred exchanges
  if (recommendations.length < limit) {
    const needed = limit - recommendations.length
    const topFromPreferred = await getTopFromExchanges(supabase, preferredExchanges, needed * 2)
    for (const t of topFromPreferred) {
      const key = `${t.source}:${t.source_trader_id}`
      if (!followedSet.has(key)) {
        followedSet.add(key)
        recommendations.push({
          ...t,
          reason: 'preferred_exchange',
          reason_detail: `Top on ${t.source}`,
        })
      }
      if (recommendations.length >= limit) break
    }
  }

  return recommendations.slice(0, limit)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getUserFollowedTraders(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
): Promise<FollowedTrader[]> {
  try {
    // user_follows tracks user-to-user follows; we need to find if the followed
    // users have linked trader profiles. For simplicity, check if user_follows
    // has a trader_source / trader_id pattern, or fall back to leaderboard lookup.
    const { data: follows } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .limit(50)

    if (!follows || follows.length === 0) return []

    // Look up followed users' linked traders via profiles or leaderboard
    const followingIds = follows.map((f: { following_id: string }) => f.following_id)

    // Try to find traders these users are associated with via leaderboard_ranks
    // (profiles may have a linked_trader_source / linked_trader_id)
    // Fallback: treat following_id as potential source_trader_id
    const { data: ranks } = await supabase
      .from('leaderboard_ranks')
      .select('source, source_trader_id, arena_score, roi')
      .eq('season_id', '90D')
      .in('source_trader_id', followingIds)
      .limit(50)

    return (ranks || []) as FollowedTrader[]
  } catch (err) {
    logger.error('getUserFollowedTraders failed', { error: err })
    return []
  }
}

async function findSimilarTraders(
  supabase: ReturnType<typeof getSupabase>,
  baseTrader: FollowedTrader,
  limit: number,
): Promise<RankRow[]> {
  const baseRoi = baseTrader.roi ?? 0
  const roiMin = baseRoi * 0.7
  const roiMax = baseRoi * 1.3

  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate')
    .eq('season_id', '90D')
    .eq('source', baseTrader.source)
    .gte('roi', roiMin)
    .lte('roi', roiMax)
    .neq('source_trader_id', baseTrader.source_trader_id)
    .not('arena_score', 'is', null)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(limit)

  return (data || []) as unknown as RankRow[]
}

async function getTopFromExchanges(
  supabase: ReturnType<typeof getSupabase>,
  exchanges: string[],
  limit: number,
): Promise<RankRow[]> {
  if (exchanges.length === 0) return []

  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate')
    .eq('season_id', '90D')
    .in('source', exchanges)
    .not('arena_score', 'is', null)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(limit)

  return (data || []) as unknown as RankRow[]
}

async function getTopPerformersFallback(
  supabase: ReturnType<typeof getSupabase>,
  limit: number,
): Promise<PersonalRecommendation[]> {
  const { data } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate')
    .eq('season_id', '90D')
    .not('arena_score', 'is', null)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .limit(limit)

  return ((data || []) as unknown as RankRow[]).map(t => ({
    ...t,
    reason: 'top_performer' as const,
    reason_detail: `Top arena score on ${t.source}`,
  }))
}
