/**
 * 邀请码系统
 * 通过邀请码注册的用户获得 Pro 功能 7 天体验
 */

import { SupabaseClient } from '@supabase/supabase-js'

// ============================================
// 类型定义
// ============================================

export interface InviteCode {
  id: string
  code: string
  creator_id: string
  max_uses: number
  current_uses: number
  trial_days: number
  trial_tier: 'pro'
  expires_at: string | null
  created_at: string
  is_active: boolean
}

export interface InviteRedemption {
  id: string
  code_id: string
  user_id: string
  redeemed_at: string
  trial_expires_at: string
}

export interface CreateInviteOptions {
  maxUses?: number
  trialDays?: number
  trialTier?: 'pro'
  expiresInDays?: number
}

// ============================================
// 邀请码生成
// ============================================

/**
 * 生成邀请码
 */
function generateInviteCode(): string {
  // 生成 8 位大写字母数字组合，去除容易混淆的字符
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)]
  }
  return code
}

// ============================================
// 数据库操作
// ============================================

/**
 * 创建邀请码
 */
export async function createInviteCode(
  supabase: SupabaseClient,
  creatorId: string,
  options: CreateInviteOptions = {}
): Promise<InviteCode> {
  const { maxUses = 10, trialDays = 7, trialTier = 'pro', expiresInDays = 30 } = options

  const code = generateInviteCode()
  const expiresAt = expiresInDays
    ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null

  const { data, error } = await supabase
    .from('invite_codes')
    .insert({
      code,
      creator_id: creatorId,
      max_uses: maxUses,
      current_uses: 0,
      trial_days: trialDays,
      trial_tier: trialTier,
      expires_at: expiresAt,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    throw error
  }

  return data
}

/**
 * 验证邀请码
 */
export async function validateInviteCode(
  supabase: SupabaseClient,
  code: string
): Promise<{ valid: boolean; invite?: InviteCode; error?: string }> {
  const { data: invite, error } = await supabase
    .from('invite_codes')
    .select(
      'id, code, creator_id, max_uses, current_uses, trial_days, trial_tier, expires_at, created_at, is_active'
    )
    .eq('code', code.toUpperCase())
    .single()

  if (error || !invite) {
    return { valid: false, error: '邀请码不存在' }
  }

  if (!invite.is_active) {
    return { valid: false, error: '邀请码已失效' }
  }

  if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
    return { valid: false, error: '邀请码已过期' }
  }

  if (invite.current_uses >= invite.max_uses) {
    return { valid: false, error: '邀请码使用次数已达上限' }
  }

  return { valid: true, invite }
}

/**
 * 兑换邀请码 — 通过 PostgreSQL RPC 保证原子性
 *
 * All validation + 3 writes (redemption, counter increment, subscription)
 * happen in a single database transaction with SELECT ... FOR UPDATE
 * to prevent race conditions on current_uses.
 */
export async function redeemInviteCode(
  supabase: SupabaseClient,
  code: string,
  userId: string
): Promise<{ success: boolean; trialExpiresAt?: string; error?: string }> {
  const { data, error } = await supabase.rpc('redeem_invite_code', {
    p_code: code,
    p_user_id: userId,
  })

  if (error) {
    return { success: false, error: '兑换失败，请稍后重试' }
  }

  const result = data as { success: boolean; trial_expires_at?: string; error?: string }
  if (!result.success) {
    return { success: false, error: result.error }
  }

  return { success: true, trialExpiresAt: result.trial_expires_at }
}

/**
 * 获取用户创建的邀请码列表
 */
export async function getUserInviteCodes(
  supabase: SupabaseClient,
  userId: string
): Promise<InviteCode[]> {
  const { data, error } = await supabase
    .from('invite_codes')
    .select(
      'id, code, creator_id, max_uses, current_uses, trial_days, trial_tier, expires_at, created_at, is_active'
    )
    .eq('creator_id', userId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (error) {
    throw error
  }

  return data || []
}

/**
 * 获取邀请码的兑换记录
 */
export async function getInviteRedemptions(
  supabase: SupabaseClient,
  codeId: string
): Promise<InviteRedemption[]> {
  const { data, error } = await supabase
    .from('invite_redemptions')
    .select('id, code_id, user_id, redeemed_at, trial_expires_at')
    .eq('code_id', codeId)
    .order('redeemed_at', { ascending: false })
    .limit(500)

  if (error) {
    throw error
  }

  return data || []
}

/**
 * 停用邀请码
 */
export async function deactivateInviteCode(
  supabase: SupabaseClient,
  codeId: string,
  userId: string
): Promise<boolean> {
  const { error } = await supabase
    .from('invite_codes')
    .update({ is_active: false })
    .eq('id', codeId)
    .eq('creator_id', userId)

  if (error) {
    return false
  }

  return true
}

/**
 * 检查用户是否在试用期
 */
export async function checkUserTrialStatus(
  supabase: SupabaseClient,
  userId: string
): Promise<{
  isTrial: boolean
  tier?: 'pro'
  expiresAt?: string
  daysRemaining?: number
}> {
  const { data: subscription } = await supabase
    .from('user_subscriptions')
    .select('tier, status, trial_ends_at')
    .eq('user_id', userId)
    .eq('status', 'trial')
    .maybeSingle()

  if (!subscription || !subscription.trial_ends_at) {
    return { isTrial: false }
  }

  const expiresAt = new Date(subscription.trial_ends_at)
  if (expiresAt < new Date()) {
    // 试用已过期
    return { isTrial: false }
  }

  const daysRemaining = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 60 * 60 * 1000))

  return {
    isTrial: true,
    tier: subscription.tier,
    expiresAt: subscription.trial_ends_at,
    daysRemaining,
  }
}
