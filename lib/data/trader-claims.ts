/**
 * 交易员认领数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'

// ============================================
// 类型定义
// ============================================

export type VerificationMethod = 'api_key' | 'signature' | 'video' | 'social'
export type ClaimStatus = 'pending' | 'reviewing' | 'verified' | 'rejected'

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderClaim {
  id: string
  user_id: string
  trader_id: string
  source: string
  verification_method: VerificationMethod
  verification_data: Record<string, unknown> | null
  status: ClaimStatus
  reject_reason: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  verified_at: string | null
  created_at: string
  updated_at: string
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface VerifiedTrader {
  id: string
  user_id: string
  trader_id: string
  source: string
  display_name: string | null
  bio: string | null
  avatar_url: string | null
  twitter_url: string | null
  telegram_url: string | null
  discord_url: string | null
  website_url: string | null
  verified_at: string
  verification_method: string
  can_pin_posts: boolean
  can_reply_reviews: boolean
  can_receive_messages: boolean
  created_at: string
  updated_at: string
}

export interface CreateClaimInput {
  trader_id: string
  source: string
  verification_method: VerificationMethod
  verification_data?: Record<string, unknown>
}

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface UpdateVerifiedTraderInput {
  display_name?: string
  bio?: string
  avatar_url?: string
  twitter_url?: string | null
  telegram_url?: string | null
  discord_url?: string | null
  website_url?: string | null
  can_receive_messages?: boolean
}

// ============================================
// Field constants
// ============================================

const CLAIM_FIELDS = 'id, user_id, trader_id, source, verification_method, verification_data, status, reject_reason, reviewed_by, reviewed_at, verified_at, created_at, updated_at'
const VERIFIED_TRADER_FIELDS = 'id, user_id, trader_id, source, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url, verified_at, verification_method, can_pin_posts, can_reply_reviews, can_receive_messages, created_at, updated_at'

// ============================================
// 查询函数
// ============================================

/**
 * 检查交易员是否已被认领
 */
export async function isTraderClaimed(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<boolean> {
  // Claims older than 30 days in pending/reviewing status should not block new claims.
  // Verified claims never expire.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

  // Check for verified claims (never expire) and recent pending/reviewing claims in parallel
  const [verifiedResult, pendingResult] = await Promise.all([
    supabase
      .from('trader_claims')
      .select('id')
      .eq('trader_id', traderId)
      .eq('source', source)
      .eq('status', 'verified')
      .maybeSingle(),
    supabase
      .from('trader_claims')
      .select('id')
      .eq('trader_id', traderId)
      .eq('source', source)
      .in('status', ['pending', 'reviewing'])
      .gte('created_at', thirtyDaysAgo.toISOString())
      .maybeSingle(),
  ])

  if (verifiedResult.error) throw verifiedResult.error
  if (pendingResult.error) throw pendingResult.error

  return !!(verifiedResult.data || pendingResult.data)
}

/**
 * 检查交易员是否已认证
 */
export async function isTraderVerified(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('verified_traders')
    .select('id')
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    logger.error('[trader-claims] 检查认证状态失败:', error)
    throw error
  }

  return !!data
}

/**
 * 获取交易员的认证信息
 */
export async function getVerifiedTrader(
  supabase: SupabaseClient,
  traderId: string,
  source: string
): Promise<VerifiedTrader | null> {
  const { data, error } = await supabase
    .from('verified_traders')
    .select(VERIFIED_TRADER_FIELDS)
    .eq('trader_id', traderId)
    .eq('source', source)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
}

/**
 * 获取用户的认领申请
 */
export async function getUserClaim(
  supabase: SupabaseClient,
  userId: string
): Promise<TraderClaim | null> {
  const { data, error } = await supabase
    .from('trader_claims')
    .select(CLAIM_FIELDS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    logger.error('[trader-claims] 获取用户认领失败:', error)
    throw error
  }

  return data
}

/**
 * 获取用户的认证交易员资料
 */
export async function getUserVerifiedTrader(
  supabase: SupabaseClient,
  userId: string
): Promise<VerifiedTrader | null> {
  const { data, error } = await supabase
    .from('verified_traders')
    .select(VERIFIED_TRADER_FIELDS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)

  if (error) {
    throw error
  }

  return data?.[0] ?? null
}

/**
 * Get all verified traders for a user (multi-account support)
 */
export async function getUserVerifiedTraders(
  supabase: SupabaseClient,
  userId: string
): Promise<VerifiedTrader[]> {
  const { data, error } = await supabase
    .from('verified_traders')
    .select(VERIFIED_TRADER_FIELDS)
    .eq('user_id', userId)
    .order('created_at', { ascending: true })

  if (error) {
    throw error
  }

  return data || []
}

/**
 * 获取待审核的认领申请（管理员）
 */
export async function getPendingClaims(
  supabase: SupabaseClient,
  options: { limit?: number; offset?: number } = {}
): Promise<TraderClaim[]> {
  const { limit = 50, offset = 0 } = options

  const { data, error } = await supabase
    .from('trader_claims')
    .select(CLAIM_FIELDS)
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .range(offset, offset + limit - 1)

  if (error) {
    logger.error('[trader-claims] 获取待审核申请失败:', error)
    throw error
  }

  return data || []
}

// ============================================
// 写入函数
// ============================================

/**
 * 审核认领申请（管理员）
 */
export async function reviewClaim(
  supabase: SupabaseClient,
  claimId: string,
  reviewerId: string,
  approved: boolean,
  rejectReason?: string
): Promise<TraderClaim> {
  const now = new Date().toISOString()

  // 更新申请状态
  const updateData: Record<string, unknown> = {
    status: approved ? 'verified' : 'rejected',
    reviewed_by: reviewerId,
    reviewed_at: now,
  }

  if (approved) {
    updateData.verified_at = now
  } else {
    updateData.reject_reason = rejectReason || '未提供原因'
  }

  const { data: claim, error: updateError } = await supabase
    .from('trader_claims')
    .update(updateData)
    .eq('id', claimId)
    .select()
    .single()

  if (updateError) {
    logger.error('[trader-claims] 更新申请状态失败:', updateError)
    throw updateError
  }

  // 如果通过，创建认证记录
  if (approved && claim) {
    const { error: verifyError } = await supabase
      .from('verified_traders')
      .insert({
        user_id: claim.user_id,
        trader_id: claim.trader_id,
        source: claim.source,
        verified_at: now,
        verification_method: claim.verification_method,
      })

    if (verifyError) {
      throw verifyError
    }
  }

  return claim
}

/**
 * 更新认证交易员资料
 */
export async function updateVerifiedTrader(
  supabase: SupabaseClient,
  userId: string,
  input: UpdateVerifiedTraderInput
): Promise<VerifiedTrader> {
  const updateData: Record<string, unknown> = {}

  if (input.display_name !== undefined) updateData.display_name = input.display_name
  if (input.bio !== undefined) updateData.bio = input.bio
  if (input.avatar_url !== undefined) updateData.avatar_url = input.avatar_url
  if (input.twitter_url !== undefined) updateData.twitter_url = input.twitter_url
  if (input.telegram_url !== undefined) updateData.telegram_url = input.telegram_url
  if (input.discord_url !== undefined) updateData.discord_url = input.discord_url
  if (input.website_url !== undefined) updateData.website_url = input.website_url
  if (input.can_receive_messages !== undefined) updateData.can_receive_messages = input.can_receive_messages

  const { data, error } = await supabase
    .from('verified_traders')
    .update(updateData)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) {
    logger.error('[trader-claims] 更新认证资料失败:', error)
    throw error
  }

  return data
}

/**
 * 取消认领申请
 */
export async function cancelClaim(
  supabase: SupabaseClient,
  claimId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase
    .from('trader_claims')
    .delete()
    .eq('id', claimId)
    .eq('user_id', userId)
    .eq('status', 'pending')

  if (error) {
    throw error
  }
}
