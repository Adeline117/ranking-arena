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
  const { data, error } = await supabase
    .from('trader_claims')
    .select('id')
    .eq('trader_id', traderId)
    .eq('source', source)
    .in('status', ['pending', 'reviewing', 'verified'])
    .maybeSingle()

  if (error) {
    throw error
  }

  return !!data
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
    .select('*')
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
    .select('*')
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
    .select('*')
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    throw error
  }

  return data
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
    .select('*')
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
 * 创建认领申请
 */
export async function createClaim(
  supabase: SupabaseClient,
  userId: string,
  input: CreateClaimInput
): Promise<TraderClaim> {
  // 检查用户是否已有认领
  const existingClaim = await getUserClaim(supabase, userId)
  if (existingClaim && ['pending', 'reviewing', 'verified'].includes(existingClaim.status)) {
    throw new Error('您已有一个进行中的认领申请')
  }

  // 检查交易员是否已被认领
  const isClaimed = await isTraderClaimed(supabase, input.trader_id, input.source)
  if (isClaimed) {
    throw new Error('该交易员账号已被认领')
  }

  const { data, error } = await supabase
    .from('trader_claims')
    .insert({
      user_id: userId,
      trader_id: input.trader_id,
      source: input.source,
      verification_method: input.verification_method,
      verification_data: input.verification_data || {},
    })
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

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
