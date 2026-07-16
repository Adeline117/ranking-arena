/**
 * Pro 会员官方群 API
 * 自动加入、查询和退出官方群。
 *
 * 官方 registry、普通 group_members、容量分配与两个计数器都由数据库
 * 原子 RPC 维护。本文件只验证严格 acknowledgement 并映射既有 HTTP 响应。
 */

import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { verifyAuth } from '@/lib/api/auth'
import { sendNotification } from '@/lib/data/notifications'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { createLogger } from '@/lib/utils/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

const logger = createLogger('pro-official-group')
const OWNER_EMAIL = 'adelinewen1107@outlook.com'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type GetOfficialGroupAcknowledgement =
  | { status: 'invalid' | 'pro_required' | 'not_member' }
  | {
      status: 'found'
      proGroupId: string
      groupId: string
      groupNumber: number
      currentMemberCount: number
      isActive: boolean
      joinedAt: string
    }

type JoinOfficialGroupFailureStatus =
  | 'invalid'
  | 'account_inactive'
  | 'pro_required'
  | 'owner_not_found'
  | 'group_unavailable'
  | 'group_full'
  | 'banned'

type JoinOfficialGroupAcknowledgement =
  | { status: JoinOfficialGroupFailureStatus }
  | {
      status: 'joined' | 'already_member'
      proGroupId: string
      groupId: string
      groupNumber: number
      officialMemberCount: number
      registryMemberCount: number
      groupMemberCount: number
    }

type LeaveOfficialGroupAcknowledgement =
  | { status: 'invalid' | 'not_member' }
  | {
      status: 'left'
      proGroupId: string
      groupId: string
      officialMemberCount: number
      registryMemberCount: number
      groupMemberCount: number
    }

const joinFailureStatuses = new Set<JoinOfficialGroupFailureStatus>([
  'invalid',
  'account_inactive',
  'pro_required',
  'owner_not_found',
  'group_unavailable',
  'group_full',
  'banned',
])

function admin(): SupabaseClient<Database> {
  return getSupabaseAdmin()
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonicalExpected = [...expected].sort()
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  )
}

function readUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : null
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function isIntegerBetween(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
}

function readGetOfficialGroupAcknowledgement(
  value: unknown
): GetOfficialGroupAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (
    (result.status === 'invalid' ||
      result.status === 'pro_required' ||
      result.status === 'not_member') &&
    hasExactKeys(result, ['status'])
  ) {
    return { status: result.status }
  }

  if (
    result.status !== 'found' ||
    !hasExactKeys(result, [
      'current_member_count',
      'group_id',
      'group_number',
      'is_active',
      'joined_at',
      'pro_group_id',
      'status',
    ])
  ) {
    return null
  }

  const proGroupId = readUuid(result.pro_group_id)
  const groupId = readUuid(result.group_id)
  if (
    !proGroupId ||
    !groupId ||
    !isIntegerBetween(result.group_number, 1, Number.MAX_SAFE_INTEGER) ||
    !isIntegerBetween(result.current_member_count, 0, 500) ||
    typeof result.is_active !== 'boolean' ||
    !isTimestamp(result.joined_at)
  ) {
    return null
  }

  return {
    status: 'found',
    proGroupId,
    groupId,
    groupNumber: result.group_number,
    currentMemberCount: result.current_member_count,
    isActive: result.is_active,
    joinedAt: result.joined_at,
  }
}

function readJoinOfficialGroupAcknowledgement(
  value: unknown
): JoinOfficialGroupAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (
    typeof result.status === 'string' &&
    joinFailureStatuses.has(result.status as JoinOfficialGroupFailureStatus) &&
    hasExactKeys(result, ['status'])
  ) {
    return { status: result.status as JoinOfficialGroupFailureStatus }
  }

  if (
    (result.status !== 'joined' && result.status !== 'already_member') ||
    !hasExactKeys(result, [
      'group_id',
      'group_member_count',
      'group_number',
      'official_member_count',
      'pro_group_id',
      'registry_member_count',
      'status',
    ])
  ) {
    return null
  }

  const proGroupId = readUuid(result.pro_group_id)
  const groupId = readUuid(result.group_id)
  if (
    !proGroupId ||
    !groupId ||
    !isIntegerBetween(result.group_number, 1, Number.MAX_SAFE_INTEGER) ||
    !isIntegerBetween(result.official_member_count, 0, 500) ||
    !isIntegerBetween(result.registry_member_count, 0, 500) ||
    !isIntegerBetween(result.group_member_count, 1, 501) ||
    result.official_member_count !== result.registry_member_count ||
    result.group_member_count !== (result.official_member_count as number) + 1
  ) {
    return null
  }

  return {
    status: result.status,
    proGroupId,
    groupId,
    groupNumber: result.group_number,
    officialMemberCount: result.official_member_count,
    registryMemberCount: result.registry_member_count,
    groupMemberCount: result.group_member_count,
  }
}

function readLeaveOfficialGroupAcknowledgement(
  value: unknown
): LeaveOfficialGroupAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const result = value as Record<string, unknown>

  if (
    (result.status === 'invalid' || result.status === 'not_member') &&
    hasExactKeys(result, ['status'])
  ) {
    return { status: result.status }
  }

  if (
    result.status !== 'left' ||
    !hasExactKeys(result, [
      'group_id',
      'group_member_count',
      'official_member_count',
      'pro_group_id',
      'registry_member_count',
      'status',
    ])
  ) {
    return null
  }

  const proGroupId = readUuid(result.pro_group_id)
  const groupId = readUuid(result.group_id)
  if (
    !proGroupId ||
    !groupId ||
    !isIntegerBetween(result.official_member_count, 0, 500) ||
    !isIntegerBetween(result.registry_member_count, 0, 500) ||
    !isIntegerBetween(result.group_member_count, 1, 501) ||
    result.official_member_count !== result.registry_member_count ||
    result.group_member_count !== (result.official_member_count as number) + 1
  ) {
    return null
  }

  return {
    status: 'left',
    proGroupId,
    groupId,
    officialMemberCount: result.official_member_count,
    registryMemberCount: result.registry_member_count,
    groupMemberCount: result.group_member_count,
  }
}

async function getOfficialOwnerId(): Promise<string | null> {
  const { data, error } = await admin()
    .from('user_profiles')
    .select('id')
    .eq('email', OWNER_EMAIL)
    .maybeSingle()

  if (error) {
    logger.error('官方群群主账号查询失败', { code: error.code })
    throw new Error('official_owner_lookup_failed')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null

  if (!hasExactKeys(data, ['id'])) return null
  return readUuid(data.id)
}

/** GET - 获取当前用户的官方群信息。 */
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const { data, error } = await admin().rpc('get_pro_official_group_atomic', {
      p_actor_id: authResult.user.id,
    })
    if (error) {
      logger.error('Failed to fetch group info', {
        code: error.code,
        userId: authResult.user.id,
      })
      return NextResponse.json({ error: 'Failed to fetch group info' }, { status: 500 })
    }

    const acknowledgement = readGetOfficialGroupAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic official-group GET returned an invalid acknowledgement', {
        userId: authResult.user.id,
      })
      return NextResponse.json({ error: 'Failed to fetch group info' }, { status: 500 })
    }

    if (acknowledgement.status === 'pro_required') {
      return NextResponse.json(
        { error: 'Pro membership required', code: 'PRO_REQUIRED' },
        { status: 403 }
      )
    }
    if (acknowledgement.status === 'invalid') {
      logger.error('Atomic official-group GET rejected an authenticated actor id')
      return NextResponse.json({ error: 'Failed to fetch group info' }, { status: 500 })
    }
    if (acknowledgement.status === 'not_member') {
      return NextResponse.json({ success: true, data: null })
    }
    if (acknowledgement.status !== 'found') {
      logger.error('Atomic official-group GET returned an unknown status')
      return NextResponse.json({ error: 'Failed to fetch group info' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      data: {
        group_id: acknowledgement.groupId,
        group_number: acknowledgement.groupNumber,
        current_member_count: acknowledgement.currentMemberCount,
        is_active: acknowledgement.isActive,
        joined_at: acknowledgement.joinedAt,
      },
    })
  } catch (error: unknown) {
    logger.error('GET error', { error })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/** POST - 加入官方群（成为 Pro 会员时调用）。 */
export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const result = await joinProOfficialGroup(authResult.user.id)
    if (!result.success) {
      if (result.message === 'pro_required') {
        return NextResponse.json(
          { error: 'Pro membership required', code: 'PRO_REQUIRED' },
          { status: 403 }
        )
      }

      const denied = result.message === 'account_inactive' || result.message === 'banned'
      return NextResponse.json(
        { error: result.message || 'Failed to join group' },
        { status: denied ? 403 : 500 }
      )
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

/** DELETE - 离开官方群（取消订阅时调用）。 */
export async function DELETE(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const authResult = await verifyAuth(request)
    if ('error' in authResult) {
      return NextResponse.json({ error: authResult.error }, { status: authResult.status })
    }

    const left = await leaveProOfficialGroup(authResult.user.id)
    return NextResponse.json({
      success: true,
      message: left ? 'Left Pro official group' : 'You are not in the Pro official group',
    })
  } catch (error: unknown) {
    logger.error('DELETE error', { error })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

/** 服务端函数：自动加入官方群（供 webhook 调用）。 */
export async function joinProOfficialGroup(userId: string): Promise<{
  success: boolean
  message: string
  groupId?: string
}> {
  const actorId = readUuid(userId)
  if (!actorId) return { success: false, message: 'invalid' }

  try {
    const ownerId = await getOfficialOwnerId()
    if (!ownerId) return { success: false, message: 'owner_not_found' }

    const { data, error } = await admin().rpc('join_pro_official_group_atomic', {
      p_actor_id: actorId,
      p_owner_id: ownerId,
    })
    if (error) {
      logger.error('官方群原子加入失败', { code: error.code, userId: actorId })
      return { success: false, message: 'atomic_join_failed' }
    }

    const acknowledgement = readJoinOfficialGroupAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('官方群原子加入返回无效 acknowledgement', { userId: actorId })
      return { success: false, message: 'malformed_result' }
    }
    if (acknowledgement.status !== 'joined' && acknowledgement.status !== 'already_member') {
      return { success: false, message: acknowledgement.status }
    }

    if (acknowledgement.status === 'joined') {
      sendWelcomeNotification(actorId, acknowledgement.groupId)
    }
    return {
      success: true,
      message: acknowledgement.status,
      groupId: acknowledgement.groupId,
    }
  } catch (error: unknown) {
    logger.error('joinProOfficialGroup error', { error, userId: actorId })
    return { success: false, message: 'server_error' }
  }
}

/** 发送欢迎通知（fire-and-forget + dedup）。 */
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

/** 服务端函数：离开官方群（供 webhook 调用）。 */
export async function leaveProOfficialGroup(userId: string): Promise<boolean> {
  const actorId = readUuid(userId)
  if (!actorId) throw new Error('invalid_official_group_actor')

  try {
    const { data, error } = await admin().rpc('leave_pro_official_group_atomic', {
      p_actor_id: actorId,
    })
    if (error) {
      logger.error('官方群原子退出失败', { code: error.code, userId: actorId })
      throw new Error('atomic_leave_failed')
    }

    const acknowledgement = readLeaveOfficialGroupAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('官方群原子退出返回无效 acknowledgement', { userId: actorId })
      throw new Error('malformed_atomic_leave_result')
    }
    if (acknowledgement.status === 'left') return true
    if (acknowledgement.status === 'not_member') return false

    logger.error('官方群原子退出拒绝已认证用户 id', { userId: actorId })
    throw new Error('invalid_atomic_leave_actor')
  } catch (error: unknown) {
    logger.error('leaveProOfficialGroup error', { error, userId: actorId })
    throw error
  }
}
