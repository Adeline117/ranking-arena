/**
 * 交易员认领数据层
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import { sendNotification } from '@/lib/data/notifications'
import { invalidateLinkedTraderCache } from '@/lib/data/linked-traders'

// ============================================
// 类型定义
// ============================================

export type VerificationMethod = 'api_key' | 'signature' | 'video' | 'social'
export type ClaimStatus = 'pending' | 'reviewing' | 'verified' | 'rejected' | 'expired'

/** @deprecated Use UnifiedTrader from '@/lib/types/unified-trader' for application code */
export interface TraderClaim {
  id: string
  user_id: string
  trader_id: string
  source: string
  verification_method: VerificationMethod
  verification_data: Record<string, unknown> | null
  submission_version: number
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
  can_pin_posts: boolean | null
  can_reply_reviews: boolean | null
  can_receive_messages: boolean | null
  profile_version: number
  created_at: string | null
  updated_at: string | null
}

export interface SubmitClaimInput {
  trader_id: string
  source: string
  challenge_id: string
  challenge_issued_at: string
  verified_at: string
  message_sha256: string
  signature_sha256: string
}

export interface TraderClaimActivation {
  claim: TraderClaim
  linked_trader_id: string
  primary_link_id: string
  linked_count: number
  authorization_id: string | null
  arena_trader_id: number
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

export interface VerifiedTraderIdentity {
  trader_id: string
  source: string
}

// ============================================
// Field constants
// ============================================

const CLAIM_FIELDS =
  'id, user_id, trader_id, source, verification_method, verification_data, submission_version, status, reject_reason, reviewed_by, reviewed_at, verified_at, created_at, updated_at'
const VERIFIED_TRADER_FIELDS =
  'id, user_id, trader_id, source, display_name, bio, avatar_url, twitter_url, telegram_url, discord_url, website_url, verified_at, verification_method, can_pin_posts, can_reply_reviews, can_receive_messages, profile_version, created_at, updated_at'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || typeof value === 'boolean'
}

function isVerificationMethod(value: unknown): value is VerificationMethod {
  return ['api_key', 'signature', 'video', 'social'].includes(String(value))
}

function parseSubmittedClaim(
  value: unknown,
  expected: { userId: string; traderId: string; source: string }
): TraderClaim {
  const candidate = Array.isArray(value) && value.length === 1 ? value[0] : value

  if (!isRecord(candidate)) {
    throw new Error('Invalid submit_trader_claim_v2 response')
  }

  const method = candidate.verification_method
  if (
    typeof candidate.id !== 'string' ||
    candidate.user_id !== expected.userId ||
    candidate.trader_id !== expected.traderId ||
    candidate.source !== expected.source ||
    candidate.status !== 'reviewing' ||
    candidate.submission_version !== 2 ||
    !isVerificationMethod(method) ||
    method !== 'signature' ||
    !isRecord(candidate.verification_data) ||
    !(candidate.reject_reason === null || typeof candidate.reject_reason === 'string') ||
    !(candidate.reviewed_by === null || typeof candidate.reviewed_by === 'string') ||
    !(candidate.reviewed_at === null || typeof candidate.reviewed_at === 'string') ||
    candidate.verified_at !== null ||
    typeof candidate.created_at !== 'string' ||
    typeof candidate.updated_at !== 'string'
  ) {
    throw new Error('Invalid submit_trader_claim_v2 response')
  }

  return {
    id: candidate.id,
    user_id: expected.userId,
    trader_id: expected.traderId,
    source: expected.source,
    verification_method: method,
    verification_data: candidate.verification_data,
    submission_version: 2,
    status: 'reviewing',
    reject_reason: candidate.reject_reason,
    reviewed_by: candidate.reviewed_by,
    reviewed_at: candidate.reviewed_at,
    verified_at: null,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  }
}

function parseActivation(value: unknown, expectedClaimId: string): TraderClaimActivation {
  if (!isRecord(value) || !isRecord(value.claim)) {
    throw new Error('Invalid activate_trader_claim_v2 response')
  }

  const claim = value.claim
  const method = claim.verification_method
  const authorizationId = value.authorization_id

  if (
    claim.id !== expectedClaimId ||
    claim.status !== 'verified' ||
    claim.submission_version !== 2 ||
    typeof claim.user_id !== 'string' ||
    typeof claim.trader_id !== 'string' ||
    typeof claim.source !== 'string' ||
    method !== 'signature' ||
    !(claim.verification_data === null || isRecord(claim.verification_data)) ||
    !(claim.reject_reason === null || typeof claim.reject_reason === 'string') ||
    !(claim.reviewed_by === null || typeof claim.reviewed_by === 'string') ||
    !(claim.reviewed_at === null || typeof claim.reviewed_at === 'string') ||
    typeof claim.verified_at !== 'string' ||
    typeof claim.created_at !== 'string' ||
    typeof claim.updated_at !== 'string' ||
    typeof value.linked_trader_id !== 'string' ||
    typeof value.primary_link_id !== 'string' ||
    typeof value.linked_count !== 'number' ||
    !Number.isInteger(value.linked_count) ||
    value.linked_count < 1 ||
    typeof value.arena_trader_id !== 'number' ||
    !Number.isSafeInteger(value.arena_trader_id) ||
    value.arena_trader_id < 1 ||
    authorizationId !== null
  ) {
    throw new Error('Invalid activate_trader_claim_v2 response')
  }

  return {
    claim: {
      id: claim.id,
      user_id: claim.user_id,
      trader_id: claim.trader_id,
      source: claim.source,
      verification_method: method,
      verification_data: claim.verification_data,
      submission_version: 2,
      status: 'verified',
      reject_reason: claim.reject_reason,
      reviewed_by: claim.reviewed_by,
      reviewed_at: claim.reviewed_at,
      verified_at: claim.verified_at,
      created_at: claim.created_at,
      updated_at: claim.updated_at,
    },
    linked_trader_id: value.linked_trader_id,
    primary_link_id: value.primary_link_id,
    linked_count: value.linked_count,
    authorization_id: authorizationId,
    arena_trader_id: value.arena_trader_id,
  }
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
 * 获取用户对指定交易员身份的最新认领申请
 */
export async function getUserClaimForTrader(
  supabase: SupabaseClient,
  userId: string,
  traderId: string,
  source: string
): Promise<TraderClaim | null> {
  const { data, error } = await supabase
    .from('trader_claims')
    .select(CLAIM_FIELDS)
    .eq('user_id', userId)
    .eq('trader_id', traderId)
    .eq('source', source)
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
    // 'reviewing' = verification passed, awaiting the owner's manual approval
    // (the post-2026-07-09 submit path); 'pending' kept for legacy rows.
    .in('status', ['pending', 'reviewing'])
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
 * Atomically retire a stale attempt and create a distinct reviewing claim.
 * The database owns active-identity uniqueness and EVM/Solana canonicalization.
 */
export async function submitClaim(
  supabase: SupabaseClient,
  userId: string,
  input: SubmitClaimInput
): Promise<TraderClaim> {
  const { data, error } = await supabase.rpc('submit_trader_claim_v2', {
    p_user_id: userId,
    p_trader_id: input.trader_id,
    p_source: input.source,
    p_challenge_id: input.challenge_id,
    p_challenge_issued_at: input.challenge_issued_at,
    p_verified_at: input.verified_at,
    p_message_digest: input.message_sha256,
    p_signature_digest: input.signature_sha256,
  })

  if (error) {
    logger.error('[trader-claims] 原子提交认领失败:', error)
    throw error
  }

  return parseSubmittedClaim(data, {
    userId,
    traderId: input.trader_id,
    source: input.source,
  })
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
  if (approved) {
    const activation = await activateClaim(supabase, claimId, reviewerId)
    const { claim } = activation

    // These effects happen only after the database transaction commits. Cache
    // invalidation is fail-soft; the durable database projections are already
    // committed when activateClaim returns.
    await invalidateLinkedTraderCache(claim.user_id)

    sendNotification(
      supabase,
      {
        user_id: claim.user_id,
        type: 'system',
        title: 'Claim approved',
        message: `Your claim for ${claim.trader_id} (${claim.source}) is approved — your profile is now verified.`,
        reference_id: String(claim.id),
      },
      'trader-claim-approve'
    )

    return claim
  }

  const reason = rejectReason || '未提供原因'
  const { data: claim, error: updateError } = await supabase.rpc('reject_trader_claim_v2', {
    p_claim_id: claimId,
    p_reviewer_id: reviewerId,
    p_reject_reason: reason,
  })

  if (updateError) {
    logger.error('[trader-claims] 更新申请状态失败:', updateError)
    throw updateError
  }
  if (!claim) {
    throw Object.assign(new Error('Trader claim is no longer reviewable'), { code: 'P0002' })
  }

  sendNotification(
    supabase,
    {
      user_id: claim.user_id,
      type: 'system',
      title: 'Claim rejected',
      message: `Your claim for ${claim.trader_id} (${claim.source}) was not approved${rejectReason ? `: ${rejectReason}` : '.'}`,
      reference_id: String(claim.id),
    },
    'trader-claim-reject'
  )

  return claim
}

/**
 * Execute the service-only database transaction for an approved claim.
 * All user-visible projections are committed together by the RPC; callers may
 * run cache, queue, and notification effects only after this function returns.
 */
export async function activateClaim(
  supabase: SupabaseClient,
  claimId: string,
  reviewerId: string
): Promise<TraderClaimActivation> {
  const { data, error } = await supabase.rpc('activate_trader_claim_v2', {
    p_claim_id: claimId,
    p_reviewer_id: reviewerId,
  })

  if (error) {
    logger.error('[trader-claims] 原子激活认领失败:', error)
    throw error
  }

  return parseActivation(data, claimId)
}

/**
 * 更新认证交易员资料
 */
export async function updateVerifiedTrader(
  supabase: SupabaseClient,
  userId: string,
  identity: VerifiedTraderIdentity,
  expectedVersion: number,
  input: UpdateVerifiedTraderInput
): Promise<VerifiedTrader | null> {
  const updateData: Record<string, unknown> = {}

  if (input.display_name !== undefined) updateData.display_name = input.display_name
  if (input.bio !== undefined) updateData.bio = input.bio
  if (input.avatar_url !== undefined) updateData.avatar_url = input.avatar_url
  if (input.twitter_url !== undefined) updateData.twitter_url = input.twitter_url
  if (input.telegram_url !== undefined) updateData.telegram_url = input.telegram_url
  if (input.discord_url !== undefined) updateData.discord_url = input.discord_url
  if (input.website_url !== undefined) updateData.website_url = input.website_url
  if (input.can_receive_messages !== undefined)
    updateData.can_receive_messages = input.can_receive_messages

  const { data, error } = await supabase.rpc('update_verified_trader_profile_cas', {
    p_user_id: userId,
    p_trader_id: identity.trader_id,
    p_source: identity.source,
    p_expected_version: expectedVersion,
    p_updates: updateData,
  })

  if (error) {
    if (error.code === 'P0002') return null
    logger.error('[trader-claims] 更新认证资料失败:', error)
    throw error
  }

  const candidate = Array.isArray(data) && data.length === 1 ? data[0] : data
  if (
    !isRecord(candidate) ||
    typeof candidate.id !== 'string' ||
    candidate.user_id !== userId ||
    candidate.trader_id !== identity.trader_id ||
    candidate.source !== identity.source ||
    !isNullableString(candidate.display_name) ||
    !isNullableString(candidate.bio) ||
    !isNullableString(candidate.avatar_url) ||
    !isNullableString(candidate.twitter_url) ||
    !isNullableString(candidate.telegram_url) ||
    !isNullableString(candidate.discord_url) ||
    !isNullableString(candidate.website_url) ||
    typeof candidate.verified_at !== 'string' ||
    typeof candidate.verification_method !== 'string' ||
    !isNullableBoolean(candidate.can_pin_posts) ||
    !isNullableBoolean(candidate.can_reply_reviews) ||
    !isNullableBoolean(candidate.can_receive_messages) ||
    typeof candidate.profile_version !== 'number' ||
    !Number.isSafeInteger(candidate.profile_version) ||
    candidate.profile_version < expectedVersion ||
    candidate.profile_version > expectedVersion + 1 ||
    !isNullableString(candidate.created_at) ||
    !isNullableString(candidate.updated_at) ||
    Object.entries(updateData).some(([field, value]) => candidate[field] !== value)
  ) {
    const identityError = new Error('Verified trader update returned a mismatched identity')
    logger.error('[trader-claims] 更新认证资料身份不匹配:', identityError)
    throw identityError
  }

  return {
    id: candidate.id,
    user_id: userId,
    trader_id: identity.trader_id,
    source: identity.source,
    display_name: candidate.display_name,
    bio: candidate.bio,
    avatar_url: candidate.avatar_url,
    twitter_url: candidate.twitter_url,
    telegram_url: candidate.telegram_url,
    discord_url: candidate.discord_url,
    website_url: candidate.website_url,
    verified_at: candidate.verified_at,
    verification_method: candidate.verification_method,
    can_pin_posts: candidate.can_pin_posts,
    can_reply_reviews: candidate.can_reply_reviews,
    can_receive_messages: candidate.can_receive_messages,
    profile_version: candidate.profile_version,
    created_at: candidate.created_at,
    updated_at: candidate.updated_at,
  }
}

export function isVerifiedTraderProfileConflict(error: unknown): boolean {
  return isRecord(error) && error.code === '40001'
}

/**
 * 取消认领申请
 */
export async function cancelClaim(
  supabase: SupabaseClient,
  claimId: string,
  userId: string
): Promise<void> {
  const { error } = await supabase.rpc('cancel_trader_claim_v2', {
    p_claim_id: claimId,
    p_user_id: userId,
  })

  if (error) {
    throw error
  }
}
