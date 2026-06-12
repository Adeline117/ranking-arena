/**
 * Pro 会员官方群 API
 * 自动加入/查询官方群
 *
 * 历史：本路由曾调用 RPC get_user_pro_official_group / join_pro_official_group /
 * leave_pro_official_group，但这些函数从未存在过（仓库无迁移，prod 也没有）——
 * 实际一直走的是 TS fallback 路径。2026-06-12 起表由迁移
 * 20260612144445_create_pro_official_groups_tables.sql 正式创建，
 * fallback 转正为唯一实现，RPC 调用全部移除。
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyAuth } from '@/lib/api/auth'
import { hasFeatureAccess } from '@/lib/premium'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { sendNotification } from '@/lib/data/notifications'

const logger = createLogger('pro-official-group')

// 群主邮箱
const OWNER_EMAIL = 'adelinewen1107@outlook.com'
const MAX_MEMBERS_PER_GROUP = 500

function admin(): SupabaseClient {
  return getSupabaseAdmin() as SupabaseClient
}

/**
 * 原子维护 pro_official_groups.current_member_count。
 *
 * 首选：adjust_pro_group_member_count(p_group_id, p_delta) RPC —— 单条
 * UPDATE ... SET current_member_count = GREATEST(current_member_count + delta, 0)，
 * SQL 层原子（迁移 20260612154954_adjust_pro_group_member_count_rpc.sql）。
 *
 * 兜底：迁移未应用时（PGRST202/42883），降级为 recount —— SELECT count(*) 后
 * UPDATE 为精确值。非原子，但官方群 ≤500 人、写入仅来自 Stripe webhook 与
 * 本路由（低频低竞争），且 recount 写入的是绝对值而非增量，并发下最多短暂
 * 偏差、下次调用即自愈 —— 最终一致可接受。
 */
async function adjustMemberCount(proGroupId: string, delta: number): Promise<void> {
  const { error } = await admin().rpc('adjust_pro_group_member_count', {
    p_group_id: proGroupId,
    p_delta: delta,
  })
  if (!error) return

  const missingFn =
    error.code === 'PGRST202' || error.code === '42883' || /function/i.test(error.message || '')
  if (!missingFn) {
    logger.warn('adjust_pro_group_member_count RPC 失败，降级 recount', { error, proGroupId })
  }

  // recount 兜底
  const { count, error: countError } = await admin()
    .from('pro_official_group_members')
    .select('id', { count: 'exact', head: true })
    .eq('pro_group_id', proGroupId)

  if (countError || count === null || count === undefined) {
    logger.error('member recount 失败，计数未更新', { error: countError, proGroupId })
    return
  }

  const { error: updateError } = await admin()
    .from('pro_official_groups')
    .update({ current_member_count: count })
    .eq('id', proGroupId)

  if (updateError) {
    logger.error('current_member_count 更新失败', { error: updateError, proGroupId })
  }
}

/**
 * GET - 获取当前用户的官方群信息
 */
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    // 验证用户
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const { user, tier } = authResult

    // 检查是否为 Pro 会员
    if (!hasFeatureAccess(tier, 'premium_groups')) {
      return NextResponse.json(
        { error: 'Pro membership required', code: 'PRO_REQUIRED' },
        { status: 403 }
      )
    }

    // 查询用户的官方群成员记录（每用户至多一条，UNIQUE(user_id)）
    const { data: membership, error: membershipError } = await admin()
      .from('pro_official_group_members')
      .select('pro_group_id, created_at')
      .eq('user_id', user.id)
      .maybeSingle()

    if (membershipError) {
      logger.error('Failed to fetch group info', { error: membershipError, userId: user.id })
      return NextResponse.json({ error: 'Failed to fetch group info' }, { status: 500 })
    }

    if (!membership) {
      return NextResponse.json({ success: true, data: null })
    }

    const { data: proGroup, error: groupError } = await admin()
      .from('pro_official_groups')
      .select('group_id, group_number, current_member_count, is_active')
      .eq('id', membership.pro_group_id)
      .single()

    if (groupError) {
      logger.error('Failed to fetch group info', { error: groupError, userId: user.id })
      return NextResponse.json({ error: 'Failed to fetch group info' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      data: {
        group_id: proGroup.group_id,
        group_number: proGroup.group_number,
        current_member_count: proGroup.current_member_count,
        is_active: proGroup.is_active,
        joined_at: membership.created_at,
      },
    })
  } catch (error: unknown) {
    logger.error('GET error', { error })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/**
 * POST - 加入官方群（成为 Pro 会员时调用）
 */
export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // 验证用户
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const { user, tier } = authResult

    // 检查是否为 Pro 会员
    if (!hasFeatureAccess(tier, 'premium_groups')) {
      return NextResponse.json(
        { error: 'Pro membership required', code: 'PRO_REQUIRED' },
        { status: 403 }
      )
    }

    const result = await joinProOfficialGroup(user.id)

    if (!result.success) {
      return NextResponse.json({ error: result.message || 'Failed to join group' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message:
        result.message === 'joined'
          ? 'Joined Pro official group'
          : 'You are already in the Pro official group',
      group_id: result.groupId,
    })
  } catch (error: unknown) {
    logger.error('POST error', { error })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/**
 * DELETE - 离开官方群（取消订阅时调用）
 */
export async function DELETE(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    // 验证用户
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const { user } = authResult

    const left = await leaveProOfficialGroup(user.id)

    return NextResponse.json({
      success: true,
      message: left ? 'Left Pro official group' : 'You are not in the Pro official group',
    })
  } catch (error: unknown) {
    logger.error('DELETE error', { error })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/**
 * 服务端函数：自动加入官方群（供 webhook 调用）
 */
export async function joinProOfficialGroup(userId: string): Promise<{
  success: boolean
  message: string
  groupId?: string
}> {
  try {
    // 检查用户是否已在官方群
    const { data: existingMembership } = await admin()
      .from('pro_official_group_members')
      .select('pro_group_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (existingMembership) {
      const { data: groupInfo } = await admin()
        .from('pro_official_groups')
        .select('group_id')
        .eq('id', existingMembership.pro_group_id)
        .maybeSingle()

      return {
        success: true,
        message: 'already_member',
        groupId: groupInfo?.group_id,
      }
    }

    // 获取可用的群（is_active 且未满 500 人，序号最小优先）
    const { data: availableGroup } = await admin()
      .from('pro_official_groups')
      .select('id, group_id')
      .eq('is_active', true)
      .lt('current_member_count', MAX_MEMBERS_PER_GROUP)
      .order('group_number', { ascending: true })
      .limit(1)
      .maybeSingle()

    let proGroupId: string
    let groupId: string

    if (availableGroup) {
      proGroupId = availableGroup.id
      groupId = availableGroup.group_id
    } else {
      // 需要创建新群
      const result = await createNewProOfficialGroup()
      if (!result.success || !result.proGroupId || !result.groupId) {
        return { success: false, message: 'failed_to_create_group' }
      }
      proGroupId = result.proGroupId
      groupId = result.groupId
    }

    // 加入官方群记录（UNIQUE(user_id) — 并发重复加入时 23505 优雅降级为重查）
    const { error: memberError } = await admin()
      .from('pro_official_group_members')
      .insert({ user_id: userId, pro_group_id: proGroupId })

    if (memberError) {
      if (memberError.code === '23505') {
        const { data: raced } = await admin()
          .from('pro_official_group_members')
          .select('pro_group_id')
          .eq('user_id', userId)
          .maybeSingle()
        const { data: racedGroup } = raced
          ? await admin()
              .from('pro_official_groups')
              .select('group_id')
              .eq('id', raced.pro_group_id)
              .maybeSingle()
          : { data: null }
        return { success: true, message: 'already_member', groupId: racedGroup?.group_id }
      }
      logger.error('加入记录失败', { error: memberError, userId })
      return { success: false, message: memberError.message }
    }

    // 维护成员计数（原子 RPC + recount 兜底）
    await adjustMemberCount(proGroupId, 1)

    // 加入 group_members（使用 upsert 处理冲突）
    await admin().from('group_members').upsert(
      { group_id: groupId, user_id: userId, role: 'member' },
      {
        onConflict: 'group_id,user_id',
      }
    )

    // 发送欢迎通知
    sendWelcomeNotification(userId, groupId)

    return { success: true, message: 'joined', groupId }
  } catch (error: unknown) {
    logger.error('joinProOfficialGroup error', { error, userId })
    return { success: false, message: 'server_error' }
  }
}

/**
 * 创建新的官方群
 */
async function createNewProOfficialGroup(): Promise<{
  success: boolean
  proGroupId?: string
  groupId?: string
}> {
  try {
    // 获取群主 ID
    const { data: owner } = await admin()
      .from('user_profiles')
      .select('id')
      .eq('email', OWNER_EMAIL)
      .single()

    if (!owner) {
      logger.error('群主账号不存在', { email: OWNER_EMAIL })
      return { success: false }
    }

    // 获取下一个群序号
    const { data: maxNumber } = await admin()
      .from('pro_official_groups')
      .select('group_number')
      .order('group_number', { ascending: false })
      .limit(1)
      .maybeSingle()

    const nextNumber = (maxNumber?.group_number || 0) + 1

    // 创建群组
    const { data: newGroup, error: groupError } = await admin()
      .from('groups')
      .insert({
        name: `Arena Pro 会员群 #${nextNumber}`,
        name_en: `Arena Pro Member Group #${nextNumber}`,
        description:
          '欢迎加入 Arena Pro 会员专属群！在这里可以与其他 Pro 会员交流心得、获取官方支持。有问题可以直接在群里提问，我们会尽快回复。',
        description_en:
          'Welcome to the Arena Pro Member exclusive group! Chat with other Pro members, share tips, and get official support.',
        created_by: owner.id,
        visibility: 'private',
        is_premium_only: true,
      })
      .select('id')
      .single()

    if (groupError || !newGroup) {
      logger.error('创建群组失败', { error: groupError })
      return { success: false }
    }

    // 创建官方群配置
    const { data: proGroup, error: proGroupError } = await admin()
      .from('pro_official_groups')
      .insert({
        group_id: newGroup.id,
        group_number: nextNumber,
      })
      .select('id')
      .single()

    if (proGroupError || !proGroup) {
      logger.error('创建官方群配置失败', { error: proGroupError, groupId: newGroup.id })
      return { success: false }
    }

    // 将群主加入群成员
    await admin()
      .from('group_members')
      .insert({ group_id: newGroup.id, user_id: owner.id, role: 'owner' })

    logger.info('创建新群成功', { groupNumber: nextNumber, groupId: newGroup.id })

    return {
      success: true,
      proGroupId: proGroup.id,
      groupId: newGroup.id,
    }
  } catch (error: unknown) {
    logger.error('createNewProOfficialGroup error', { error })
    return { success: false }
  }
}

/**
 * 发送欢迎通知（fire-and-forget + dedup，经由 lib/data/notifications 强制规范）
 */
function sendWelcomeNotification(userId: string, groupId: string) {
  sendNotification(
    admin(),
    {
      user_id: userId,
      type: 'system',
      title: '欢迎加入 Pro 会员官方群',
      message:
        '你已自动加入 Arena Pro 会员官方群！在这里可以与其他 Pro 会员交流，有问题可以直接在群里提问。',
      link: `/groups/${groupId}`,
      read: false,
    },
    'pro-official-group:welcome'
  )
}

/**
 * 服务端函数：离开官方群（供 webhook 调用）
 */
export async function leaveProOfficialGroup(userId: string): Promise<boolean> {
  try {
    const { data: membership } = await admin()
      .from('pro_official_group_members')
      .select('pro_group_id')
      .eq('user_id', userId)
      .maybeSingle()

    if (!membership) return false

    const { data: proGroup } = await admin()
      .from('pro_official_groups')
      .select('group_id')
      .eq('id', membership.pro_group_id)
      .maybeSingle()

    if (proGroup) {
      await admin()
        .from('group_members')
        .delete()
        .eq('group_id', proGroup.group_id)
        .eq('user_id', userId)
    }

    const { error: deleteError } = await admin()
      .from('pro_official_group_members')
      .delete()
      .eq('user_id', userId)

    if (deleteError) {
      logger.error('离开官方群删除记录失败', { error: deleteError, userId })
      return false
    }

    // 维护成员计数（原子 RPC + recount 兜底）
    await adjustMemberCount(membership.pro_group_id, -1)

    return true
  } catch (error: unknown) {
    logger.error('leaveProOfficialGroup error', { error, userId })
    return false
  }
}
