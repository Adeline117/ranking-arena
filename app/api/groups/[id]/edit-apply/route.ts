import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'
import type { Database } from '@/lib/supabase/database.types'
import {
  groupEditApplicationInputSchema,
  groupEditGroupIdSchema,
  submitGroupEditApplicationResultSchema,
  type GroupEditApplicationInput,
  type SubmitGroupEditApplicationResult,
} from '../../edit-applications/contracts'

// 检查用户是否是小组组长（兼容旧数据：admin + 创建者也视为组长）
async function isGroupOwner(
  supabase: SupabaseClient<Database>,
  groupId: string,
  userId: string
): Promise<boolean> {
  const { data: memberData } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()

  if (memberData?.role === 'owner') return true

  // 兼容旧数据：如果用户是 admin 且是小组创建者，也视为组长
  if (memberData?.role === 'admin') {
    const { data: groupData } = await supabase
      .from('groups')
      .select('created_by')
      .eq('id', groupId)
      .single()

    if (groupData?.created_by === userId) return true
  }

  return false
}

/** Extract group id from URL path */
function extractGroupId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('groups')
  return pathParts[idx + 1]
}

function submitFailureResponse(result: SubmitGroupEditApplicationResult): NextResponse {
  switch (result.status) {
    case 'invalid':
      return NextResponse.json({ error: 'Invalid edit application' }, { status: 400 })
    case 'account_inactive':
      return NextResponse.json({ error: 'Your account is not active' }, { status: 403 })
    case 'forbidden':
      return NextResponse.json(
        { error: 'Only the group owner can modify group info' },
        { status: 403 }
      )
    case 'not_found':
      return NextResponse.json({ error: 'Group not found' }, { status: 404 })
    case 'dissolved':
      return NextResponse.json(
        { error: 'The group has been dissolved', code: 'GROUP_DISSOLVED' },
        { status: 403 }
      )
    case 'premium_change_unsupported':
      return NextResponse.json(
        {
          error: 'Premium access mode cannot be changed through a profile edit',
          code: 'PREMIUM_CHANGE_UNSUPPORTED',
        },
        { status: 409 }
      )
    case 'name_taken':
      return NextResponse.json(
        { error: 'A group with this name already exists', code: 'NAME_TAKEN' },
        { status: 409 }
      )
    case 'pending_exists':
      return NextResponse.json(
        { error: 'You already have a pending edit application' },
        { status: 409 }
      )
    case 'operation_conflict':
      return NextResponse.json(
        { error: 'Operation id conflicts with another request' },
        { status: 409 }
      )
    default:
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
  }
}

function matchesSubmittedApplication(
  input: GroupEditApplicationInput,
  application: Extract<SubmitGroupEditApplicationResult, { status: 'submitted' }>['application'],
  groupId: string,
  actorId: string
): boolean {
  return (
    application.group_id === groupId &&
    application.applicant_id === actorId &&
    application.name === input.name &&
    application.name_en === input.name_en &&
    application.description === input.description &&
    application.description_en === input.description_en &&
    application.avatar_url === input.avatar_url &&
    jsonValuesEqual(application.role_names, input.role_names) &&
    jsonValuesEqual(application.rules_json, input.rules_json) &&
    application.rules === input.rules &&
    application.is_premium_only === input.is_premium_only
  )
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    )
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }

  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const leftKeys = Object.keys(leftRecord).sort()
  const rightKeys = Object.keys(rightRecord).sort()
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) => key === rightKeys[index] && jsonValuesEqual(leftRecord[key], rightRecord[key])
    )
  )
}

// 提交小组信息修改申请
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedGroupId = groupEditGroupIdSchema.safeParse(extractGroupId(request.url))
    if (!parsedGroupId.success) {
      return NextResponse.json({ error: 'Invalid group id' }, { status: 400 })
    }
    const groupId = parsedGroupId.data
    const sb: SupabaseClient<Database> = supabase

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = groupEditApplicationInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid edit application' }, { status: 400 })
    }
    const input = parsedBody.data

    const { data, error } = await sb.rpc('submit_group_edit_application_atomic', {
      p_actor_id: user.id,
      p_group_id: groupId,
      p_name: input.name,
      p_name_en: input.name_en,
      p_description: input.description,
      p_description_en: input.description_en,
      p_avatar_url: input.avatar_url,
      p_role_names: input.role_names,
      p_rules_json: input.rules_json,
      p_rules: input.rules,
      p_is_premium_only: input.is_premium_only,
      p_operation_id: input.operation_id,
    })

    if (error) {
      logger.error('Atomic group edit application submission failed', {
        error,
        groupId,
        actorId: user.id,
      })
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    const parsedResult = submitGroupEditApplicationResultSchema.safeParse(data)
    if (!parsedResult.success) {
      logger.error('Atomic group edit application submission returned an invalid result', {
        groupId,
        actorId: user.id,
      })
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    const result = parsedResult.data
    if (result.status !== 'submitted') return submitFailureResponse(result)
    if (
      result.operation_id !== input.operation_id ||
      !matchesSubmittedApplication(input, result.application, groupId, user.id)
    ) {
      logger.error(
        'Atomic group edit application submission returned a mismatched acknowledgement',
        {
          groupId,
          actorId: user.id,
        }
      )
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Edit application submitted, pending admin review',
      operation_id: result.operation_id,
      application: result.application,
    })
  },
  { name: 'groups/edit-apply-post', rateLimit: 'write' }
)

// 获取小组的修改申请列表（组长可查看）
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const parsedGroupId = groupEditGroupIdSchema.safeParse(extractGroupId(request.url))
    if (!parsedGroupId.success) {
      return NextResponse.json({ error: 'Invalid group id' }, { status: 400 })
    }
    const groupId = parsedGroupId.data
    const sb: SupabaseClient<Database> = supabase

    // 检查是否是组长
    if (!(await isGroupOwner(sb, groupId, user.id))) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const { data: applications, error } = await sb
      .from('group_edit_applications')
      .select(
        'id, group_id, applicant_id, name, name_en, description, description_en, avatar_url, rules_json, rules, role_names, is_premium_only, status, reject_reason, reviewed_at, created_at'
      )
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('Fetch edit applications error:', error)
      return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
    }

    return NextResponse.json({ applications })
  },
  { name: 'groups/edit-apply-get', rateLimit: 'read' }
)
