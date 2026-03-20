import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

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

// 提交小组信息修改申请
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId } = await params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // 只有组长可以提交修改申请
    if (!await isGroupOwner(supabase, groupId, user.id)) {
      return NextResponse.json({ error: 'Only the group owner can modify group info' }, { status: 403 })
    }

    // 检查是否已有待审核的修改申请
    const { data: existingApp } = await supabase
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
    const { data: application, error: insertError } = await supabase
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

  } catch (error: unknown) {
    logger.error('Edit apply error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

// 获取小组的修改申请列表（组长可查看）
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const { id: groupId } = await params
    
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = getSupabaseAdmin()

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // 检查是否是组长
    if (!await isGroupOwner(supabase, groupId, user.id)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const { data: applications, error } = await supabase
      .from('group_edit_applications')
      .select('id, group_id, applicant_id, name, name_en, description, description_en, avatar_url, rules_json, rules, role_names, is_premium_only, status, reject_reason, reviewed_at, reviewed_by, created_at')
      .eq('group_id', groupId)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('Fetch edit applications error:', error)
      return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
    }

    return NextResponse.json({ applications })

  } catch (error: unknown) {
    logger.error('Get edit applications error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
