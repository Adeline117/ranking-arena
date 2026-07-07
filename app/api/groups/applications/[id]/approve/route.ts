import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import { notifyNewGroup } from '@/lib/notifications/activity-alerts'

// 批准小组申请
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await params

    const supabase = getSupabaseAdmin() as SupabaseClient

    // SECURITY: use verifyAdmin so ADMIN_EMAILS env allowlist is enforced in
    // production (matches /api/admin/* gating). Replaces a DB-only role check
    // that would have bypassed the operational whitelist.
    const admin = await verifyAdmin(supabase, request.headers.get('Authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }
    const user = { id: admin.id }

    // 获取申请信息（含建群所需的全部字段）
    const { data: application, error: fetchError } = await supabase
      .from('group_applications')
      .select(
        'id, status, applicant_id, name, name_en, description, description_en, avatar_url, role_names, rules_json, rules, is_premium_only'
      )
      .eq('id', id)
      .single()

    if (fetchError || !application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    if (application.status !== 'pending') {
      return NextResponse.json(
        { error: 'This application has already been processed' },
        { status: 400 }
      )
    }

    // 事务性：先建群 + 加组长成员成功，才把申请翻 approved。
    // 若建群失败则直接回错误、不标 approved，避免留下 approved 但无群的半吊子。
    const groupName = (application.name ?? '').trim()
    const slug =
      groupName
        .toLowerCase()
        .replace(/[^a-z0-9一-龥]+/g, '-')
        .replace(/^-|-$/g, '') || `group-${Date.now()}`

    const { data: newGroup, error: groupError } = await supabase
      .from('groups')
      .insert({
        name: groupName,
        name_en: application.name_en ?? null,
        description: application.description ?? null,
        description_en: application.description_en ?? null,
        avatar_url: application.avatar_url ?? null,
        slug,
        created_by: application.applicant_id,
        role_names: application.role_names ?? null,
        rules_json: application.rules_json ?? null,
        rules: application.rules ?? null,
        is_premium_only: application.is_premium_only ?? false,
      })
      .select('id')
      .single()

    if (groupError || !newGroup) {
      logger.error('Error creating group on approval:', groupError)
      return NextResponse.json({ error: 'Failed to create group' }, { status: 500 })
    }

    // 加申请人为组长（owner）。失败仅记录，不阻断——群已建成。
    const { error: memberError } = await supabase.from('group_members').insert({
      group_id: newGroup.id,
      user_id: application.applicant_id,
      role: 'owner',
    })

    if (memberError) {
      logger.error('Error adding group owner on approval:', memberError)
    }

    // 群建成后，才把申请翻 approved 并记录 group_id + 审核人/时间
    const { error: updateError } = await supabase
      .from('group_applications')
      .update({
        status: 'approved',
        group_id: newGroup.id,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id,
      })
      .eq('id', id)

    if (updateError) {
      logger.error('Error approving application:', updateError)
      return NextResponse.json({ error: 'Approval failed' }, { status: 500 })
    }

    // 实时通知 (fire-and-forget)
    notifyNewGroup(null, groupName)

    return NextResponse.json({
      success: true,
      message: 'Group application approved',
      group: newGroup,
    })
  } catch (error: unknown) {
    logger.error('Error approving application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
