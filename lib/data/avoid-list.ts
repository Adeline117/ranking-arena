/**
 * 避雷榜数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sanitizePublicRankingPayload } from '@/lib/rankings/publication-policy'
import { PUBLIC_PROFILE_RANKING_COLUMNS } from '@/lib/data/trader/public-profile-ranking'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// ============================================
// 类型定义
// ============================================

export type AvoidReasonType =
  | 'high_drawdown'
  | 'fake_data'
  | 'inconsistent'
  | 'poor_communication'
  | 'other'

export interface AvoidVote {
  id: string
  user_id: string
  trader_id: string
  source: string
  reason: string | null
  reason_type: AvoidReasonType | null
  loss_amount: number | null
  loss_percent: number | null
  follow_duration_days: number | null
  screenshot_url: string | null
  created_at: string
  updated_at: string
  // 关联数据
  author_handle?: string
  author_avatar_url?: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderAvoidScore {
  trader_id: string
  source: string
  avoid_count: number
  high_drawdown_count: number
  fake_data_count: number
  inconsistent_count: number
  avg_loss_percent: number | null
  avg_follow_days: number | null
  latest_vote_at: string
  // 关联数据
  handle?: string
  roi?: number
}

export interface CreateAvoidVoteInput {
  trader_id: string
  source: string
  reason?: string
  reason_type?: AvoidReasonType
  loss_amount?: number
  loss_percent?: number
  follow_duration_days?: number
  screenshot_url?: string
}

// ============================================
// 查询函数
// ============================================

/**
 * 获取避雷榜（按投票数排序）
 */
export async function getAvoidList(
  supabase: SupabaseClient,
  options: { limit?: number; offset?: number } = {}
): Promise<TraderAvoidScore[]> {
  const { limit = 20, offset = 0 } = options

  const { data, error } = await supabase
    .from('trader_avoid_scores')
    .select(
      'trader_id, source, avoid_count, high_drawdown_count, fake_data_count, inconsistent_count, avg_loss_percent, avg_follow_days, latest_vote_at'
    )
    .order('avoid_count', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    throw error
  }

  if (!data || data.length === 0) return []

  // The avoid list needs only a display identity. It must still come from the
  // sealed public cohort: an unpublished raw rank may not decide which handle
  // a public endpoint associates with a vote record.
  const traderIds = data.map((d) => d.trader_id)
  const { data: publicRows, error: publicError } = await supabase
    .from('public_ranked_leaderboard')
    .select(PUBLIC_PROFILE_RANKING_COLUMNS)
    .in('source_trader_id', traderIds)
    .eq('season_id', '90D')
  if (publicError)
    logger.warn('[getAvoidList] public ranking cohort query error:', publicError.message)

  const sanitized = publicError
    ? []
    : ((
        sanitizePublicRankingPayload(
          { traders: publicRows ?? [], period: '90D' },
          { expectedPeriod: '90D' }
        ) as { traders?: unknown[] }
      ).traders ?? [])

  const handleMap = new Map<string, string>()
  const ambiguousIdentityKeys = new Set<string>()
  for (const row of sanitized) {
    if (!isRecord(row)) continue
    const sourceTraderId = row.source_trader_id
    const source = row.source
    if (typeof sourceTraderId !== 'string' || typeof source !== 'string') continue

    const key = `${sourceTraderId}:${source}`
    // A source/key/period should be unique in the public view. Do not choose
    // an arbitrary identity if a proxy or schema regression duplicates it.
    if (handleMap.has(key)) {
      ambiguousIdentityKeys.add(key)
      handleMap.delete(key)
      continue
    }
    handleMap.set(
      key,
      typeof row.handle === 'string' && row.handle.trim().length > 0 ? row.handle : sourceTraderId
    )
  }

  return data.map((d) => ({
    ...d,
    handle: ambiguousIdentityKeys.has(`${d.trader_id}:${d.source}`)
      ? d.trader_id
      : handleMap.get(`${d.trader_id}:${d.source}`) || d.trader_id,
  }))
}

/**
 * 获取交易员的避雷信息
 */
export async function getTraderAvoidScore(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<TraderAvoidScore | null> {
  const { data, error } = await supabase
    .from('trader_avoid_scores')
    .select(
      'trader_id, source, avoid_count, high_drawdown_count, fake_data_count, inconsistent_count, avg_loss_percent, avg_follow_days, latest_vote_at'
    )
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

/**
 * 获取交易员的避雷投票列表
 */
export async function getTraderAvoidVotes(
  supabase: SupabaseClient,
  traderId: string,
  source: string,
  options: { limit?: number; offset?: number } = {}
): Promise<AvoidVote[]> {
  const { limit = 20, offset = 0 } = options

  const { data, error } = await supabase
    .from('avoid_votes')
    .select(
      'id, user_id, trader_id, source, reason, reason_type, loss_amount, loss_percent, follow_duration_days, screenshot_url, created_at, updated_at'
    )
    .eq('trader_id', traderId)
    .eq('source', source)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1)

  if (error) {
    throw error
  }

  if (!data || data.length === 0) return []

  // 获取投票者信息
  const userIds = Array.from(new Set(data.map((v) => v.user_id)))
  const { data: profiles, error: profilesError } = await supabase
    .from('user_profiles')
    .select('id, handle, avatar_url')
    .in('id', userIds)
  if (profilesError)
    logger.warn('[getTraderAvoidVotes] user_profiles query error (drift?):', profilesError.message)

  const profileMap = new Map<string, { handle: string; avatar_url: string | null }>()
  profiles?.forEach((p) => {
    profileMap.set(p.id, { handle: p.handle || '匿名用户', avatar_url: p.avatar_url })
  })

  return data.map((vote) => {
    const profile = profileMap.get(vote.user_id)
    return {
      ...vote,
      author_handle: profile?.handle || '匿名用户',
      author_avatar_url: profile?.avatar_url || undefined,
    }
  })
}

/**
 * 检查用户是否已投过避雷票
 */
export async function hasUserVoted(
  supabase: SupabaseClient,
  userId: string,
  traderId: string,
  source: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('avoid_votes')
    .select('id')
    .eq('user_id', userId)
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    throw error
  }

  return !!data
}

/**
 * 获取用户的避雷投票
 */
export async function getUserAvoidVote(
  supabase: SupabaseClient,
  userId: string,
  traderId: string,
  source: string
): Promise<AvoidVote | null> {
  const { data, error } = await supabase
    .from('avoid_votes')
    .select(
      'id, user_id, trader_id, source, reason, reason_type, loss_amount, loss_percent, follow_duration_days, screenshot_url, created_at, updated_at'
    )
    .eq('user_id', userId)
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    logger.error('[avoid-list] 获取用户投票失败:', error)
    throw error
  }

  return data
}

// ============================================
// 写入函数
// ============================================

/**
 * 创建避雷投票
 */
export async function createAvoidVote(
  supabase: SupabaseClient,
  userId: string,
  input: CreateAvoidVoteInput
): Promise<AvoidVote> {
  const { data, error } = await supabase
    .from('avoid_votes')
    .insert({
      user_id: userId,
      trader_id: input.trader_id,
      source: input.source,
      reason: input.reason,
      reason_type: input.reason_type,
      loss_amount: input.loss_amount,
      loss_percent: input.loss_percent,
      follow_duration_days: input.follow_duration_days,
      screenshot_url: input.screenshot_url,
    })
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

/**
 * 更新避雷投票
 */
export async function updateAvoidVote(
  supabase: SupabaseClient,
  voteId: string,
  userId: string,
  input: Partial<CreateAvoidVoteInput>
): Promise<AvoidVote> {
  const updateData: Record<string, unknown> = {}

  if (input.reason !== undefined) updateData.reason = input.reason
  if (input.reason_type !== undefined) updateData.reason_type = input.reason_type
  if (input.loss_amount !== undefined) updateData.loss_amount = input.loss_amount
  if (input.loss_percent !== undefined) updateData.loss_percent = input.loss_percent
  if (input.follow_duration_days !== undefined)
    updateData.follow_duration_days = input.follow_duration_days
  if (input.screenshot_url !== undefined) updateData.screenshot_url = input.screenshot_url

  const { data, error } = await supabase
    .from('avoid_votes')
    .update(updateData)
    .eq('id', voteId)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    logger.error('[avoid-list] 更新避雷投票失败:', error)
    throw error
  }

  return data
}

/**
 * 删除避雷投票
 */
export async function deleteAvoidVote(
  supabase: SupabaseClient,
  voteId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('avoid_votes')
    .delete()
    .eq('id', voteId)
    .eq('user_id', userId)

  if (error) {
    throw error
  }
}
