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
import { createHash } from 'node:crypto'
import { tieredGetOrSet } from '@/lib/cache/redis-layer'
import { isPublicRankingSourceAllowed } from '@/lib/rankings/publication-policy'
import type { SealedLeaderboardPublicationProofSet } from '@/lib/rankings/read-publication-proofs'
import {
  readSealedRankingAuthorityGeneration,
  sealedRankingPublicationIdentity,
} from '@/lib/rankings/read-sealed-ranking-generation'

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
  limit = 20
): Promise<PersonalRecommendation[]> {
  const supabase = getSupabase()
  const sealedRead = await readSealedRankingAuthorityGeneration(
    supabase,
    '90D',
    async (publication) => {
      const allowedSources = publication.proofs
        .map((proof) => proof.source)
        .filter(isPublicRankingSourceAllowed)
      if (allowedSources.length === 0) {
        throw new Error('personal recommendations publication has no public sources')
      }
      const proofFingerprint = createHash('sha256')
        .update(sealedRankingPublicationIdentity(publication))
        .digest('hex')
        .slice(0, 24)
      return tieredGetOrSet<PersonalRecommendation[]>(
        `recommendations:personal:sealed-v2:${userId}:${limit}:${proofFingerprint}`,
        () => buildPersonalRecommendations(supabase, userId, limit, publication, allowedSources),
        'hot',
        ['recommendations', `user:${userId}`]
      )
    },
    { timeoutMs: 10_000 }
  )
  return sealedRead.value
}

async function buildPersonalRecommendations(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  limit: number,
  publication: SealedLeaderboardPublicationProofSet,
  allowedSources: readonly string[]
): Promise<PersonalRecommendation[]> {
  // 1. Get user's followed traders (via user_follows -> trader mapping)
  const followedTraders = await getUserFollowedTraders(
    supabase,
    userId,
    publication,
    allowedSources
  )

  if (followedTraders.length === 0) {
    // Fallback: return top performers across exchanges
    return getTopPerformersFallback(supabase, limit, publication, allowedSources)
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
  const followedSet = new Set(followedTraders.map((t) => `${t.source}:${t.source_trader_id}`))

  const recommendations: PersonalRecommendation[] = []

  // 4. Find similar traders (same exchange, similar ROI range)
  for (const trader of followedTraders.slice(0, 10)) {
    const similar = await findSimilarTraders(supabase, trader, 5, publication, allowedSources)
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
    const topFromPreferred = await getTopFromExchanges(
      supabase,
      preferredExchanges,
      needed * 2,
      publication,
      allowedSources
    )
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

function requireRankRows<T extends { source: string }>(
  data: unknown,
  error: { message?: string } | null,
  label: string,
  allowedSources: readonly string[]
): T[] {
  if (error) {
    throw new Error(`${label} failed: ${error.message || 'unknown database error'}`)
  }
  if (!Array.isArray(data)) {
    throw new Error(`${label} returned no row array`)
  }
  const allowed = new Set(allowedSources)
  for (const [index, row] of data.entries()) {
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      typeof (row as Record<string, unknown>).source !== 'string' ||
      !allowed.has((row as Record<string, unknown>).source as string)
    ) {
      throw new Error(`${label} row ${index} escaped publication authority`)
    }
  }
  return data as T[]
}

async function getUserFollowedTraders(
  supabase: ReturnType<typeof getSupabase>,
  userId: string,
  publication: SealedLeaderboardPublicationProofSet,
  allowedSources: readonly string[]
): Promise<FollowedTrader[]> {
  try {
    // user_follows is user-to-user. Resolve those users through the canonical
    // linked-trader table before touching ranking data; auth UUIDs are not
    // exchange trader IDs.
    const { data: follows, error: followsError } = await supabase
      .from('user_follows')
      .select('following_id')
      .eq('follower_id', userId)
      .limit(50)

    if (followsError) {
      throw new Error(`follow directory query failed: ${followsError.message}`)
    }
    if (!follows || follows.length === 0) return []

    const followingIds = follows.map((f: { following_id: string }) => f.following_id)
    const { data: linkedRows, error: linkedError } = await supabase
      .from('user_linked_traders')
      .select('user_id, source, trader_id')
      .in('user_id', followingIds)
      .order('user_id', { ascending: true })
      .order('source', { ascending: true })
      .order('trader_id', { ascending: true })
      .limit(200)
    if (linkedError) {
      throw new Error(`followed trader link query failed: ${linkedError.message}`)
    }
    if (!linkedRows) return []

    const allowed = new Set(allowedSources)
    const identities = [
      ...new Map(
        linkedRows
          .filter(
            (row) =>
              typeof row.source === 'string' &&
              allowed.has(row.source) &&
              typeof row.trader_id === 'string' &&
              row.trader_id.length > 0
          )
          .map((row) => [
            `${row.source}\u0000${row.trader_id}`,
            { source: row.source, sourceTraderId: row.trader_id },
          ])
      ).values(),
    ]
    if (identities.length === 0) return []

    const idsBySource = new Map<string, string[]>()
    for (const identity of identities) {
      const ids = idsBySource.get(identity.source) ?? []
      ids.push(identity.sourceTraderId)
      idsBySource.set(identity.source, ids)
    }
    const rankBatches = await Promise.all(
      [...idsBySource.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([source, traderIds]) => {
          const requestedIds = new Set(traderIds)
          const { data: ranks, error: ranksError } = await supabase
            .from('leaderboard_ranks')
            .select('source, source_trader_id, arena_score, roi')
            .eq('season_id', '90D')
            .filter('rank_publication_id', 'eq', publication.scoreCohortId)
            .eq('source', source)
            .in('source_trader_id', traderIds)
            .order('source_trader_id', { ascending: true })
            .limit(traderIds.length)
          const rows = requireRankRows<FollowedTrader>(
            ranks,
            ranksError,
            'followed trader rank query',
            allowedSources
          )
          if (
            rows.some((row) => row.source !== source || !requestedIds.has(row.source_trader_id))
          ) {
            throw new Error('followed trader rank query returned an unrequested identity')
          }
          return rows
        })
    )
    return rankBatches.flat()
  } catch (err) {
    logger.error('getUserFollowedTraders failed', { error: err })
    throw err instanceof Error ? err : new Error('followed trader lookup failed')
  }
}

async function findSimilarTraders(
  supabase: ReturnType<typeof getSupabase>,
  baseTrader: FollowedTrader,
  limit: number,
  publication: SealedLeaderboardPublicationProofSet,
  allowedSources: readonly string[]
): Promise<RankRow[]> {
  if (!allowedSources.includes(baseTrader.source)) return []
  const baseRoi = baseTrader.roi ?? 0
  const roiMin = Math.min(baseRoi * 0.7, baseRoi * 1.3)
  const roiMax = Math.max(baseRoi * 0.7, baseRoi * 1.3)

  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate')
    .eq('season_id', '90D')
    .filter('rank_publication_id', 'eq', publication.scoreCohortId)
    .eq('source', baseTrader.source)
    .gte('roi', roiMin)
    .lte('roi', roiMax)
    .neq('source_trader_id', baseTrader.source_trader_id)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .order('source_trader_id', { ascending: true })
    .limit(limit)

  return requireRankRows<RankRow>(data, error, 'similar trader rank query', allowedSources)
}

async function getTopFromExchanges(
  supabase: ReturnType<typeof getSupabase>,
  exchanges: string[],
  limit: number,
  publication: SealedLeaderboardPublicationProofSet,
  allowedSources: readonly string[]
): Promise<RankRow[]> {
  const allowed = new Set(allowedSources)
  const requestedSources = [...new Set(exchanges.filter((source) => allowed.has(source)))].sort()
  if (requestedSources.length === 0) return []

  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate')
    .eq('season_id', '90D')
    .filter('rank_publication_id', 'eq', publication.scoreCohortId)
    .in('source', requestedSources)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .order('source', { ascending: true })
    .order('source_trader_id', { ascending: true })
    .limit(limit)

  return requireRankRows<RankRow>(data, error, 'preferred exchange rank query', allowedSources)
}

async function getTopPerformersFallback(
  supabase: ReturnType<typeof getSupabase>,
  limit: number,
  publication: SealedLeaderboardPublicationProofSet,
  allowedSources: readonly string[]
): Promise<PersonalRecommendation[]> {
  const { data, error } = await supabase
    .from('leaderboard_ranks')
    .select('source, source_trader_id, handle, avatar_url, arena_score, roi, pnl, win_rate')
    .eq('season_id', '90D')
    .filter('rank_publication_id', 'eq', publication.scoreCohortId)
    .in('source', allowedSources)
    .gt('arena_score', 0)
    .or('is_outlier.is.null,is_outlier.eq.false')
    .order('arena_score', { ascending: false })
    .order('source', { ascending: true })
    .order('source_trader_id', { ascending: true })
    .limit(limit)

  return requireRankRows<RankRow>(data, error, 'top performer rank query', allowedSources).map(
    (t) => ({
      ...t,
      reason: 'top_performer' as const,
      reason_detail: `Top arena score on ${t.source}`,
    })
  )
}
