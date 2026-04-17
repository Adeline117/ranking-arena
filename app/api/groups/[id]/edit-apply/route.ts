import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { withAuth } from '@/lib/api/middleware'
import { socialFeatureGuard } from '@/lib/features'

// 检查用户是否是小组组长（兼容旧数据：admin + 创建者也视为组长）
async function isGroupOwner(
  supabase: SupabaseClient,
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

// 提交小组信息修改申请
export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = extractGroupId(request.url)
    const sb = supabase as SupabaseClient

    // 只有组长可以提交修改申请
    if (!await isGroupOwner(sb, groupId, user.id)) {
      return NextResponse.json({ error: 'Only the group owner can modify group info' }, { status: 403 })
    }

    // 检查是否已有待审核的修改申请
    const { data: existingApp } = await sb
      .from('group_edit_applications')
      .select('id')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .maybeSingle()

    if (existingApp) {
      return NextResponse.json({ error: 'You already have a pending edit application' }, { status: 400 })
    }

    let body: {
      name?: string
      name_en?: string
      description?: string
      description_en?: string
      avatar_url?: string
      rules_json?: unknown
      rules?: string
      role_names?: unknown
      is_premium_only?: boolean
    }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request format' }, { status: 400 })
    }
    const {
      name,
      name_en,
      description,
      description_en,
      avatar_url,
      rules_json,
      rules,
      role_names,
      is_premium_only
    } = body

    // 验证
    if (name && name.length > 50) {
      return NextResponse.json({ error: 'Group name cannot exceed 50 characters' }, { status: 400 })
    }

    if (description && description.length > 500) {
      return NextResponse.json({ error: 'Group description cannot exceed 500 characters' }, { status: 400 })
    }

    // 创建修改申请
    const { data: application, error: insertError } = await sb
      .from('group_edit_applications')
      .insert({
        group_id: groupId,
        applicant_id: user.id,
        name: name || null,
        name_en: name_en || null,
        description: description || null,
        description_en: description_en || null,
        avatar_url: avatar_url || null,
        rules_json: rules_json || null,
        rules: rules || null,
        role_names: role_names || null,
        is_premium_only: is_premium_only ?? null,
        status: 'pending'
      })
      .select()
      .single()

    if (insertError) {
      logger.error('Create edit application error:', insertError)
      return NextResponse.json({ error: 'Submission failed' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Edit application submitted, pending admin review',
      application
    })
  },
  { name: 'groups/edit-apply-post', rateLimit: 'write' }
)

// 获取小组的修改申请列表（组长可查看）
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const groupId = extractGroupId(request.url)
    const sb = supabase as SupabaseClient

    // 检查是否是组长
    if (!await isGroupOwner(sb, groupId, user.id)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const { data: applications, error } = await sb
      .from('group_edit_applications')
      .select('id, group_id, applicant_id, name, name_en, description, description_en, avatar_url, rules_json, rules, role_names, is_premium_only, status, reject_reason, reviewed_at, reviewed_by, created_at')
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
