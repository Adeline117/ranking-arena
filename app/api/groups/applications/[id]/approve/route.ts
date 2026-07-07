import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import { notifyNewGroup } from '@/lib/notifications/activity-alerts'
import { sendNotification } from '@/lib/data/notifications'

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

    // ── 原子领取转换（防重复批准竞态）────────────────────────────────────
    // 之前是 check-then-act(读 status → 建群 → 翻 approved),中间无锁:两个并发批准
    // 会各建一个群(slug 用 Date.now() 兜底,ja/ko/emoji 名撞不到 slug 唯一索引 → 双群)。
    // 现在先做条件 UPDATE pending→approved 作为竞态门:只有 .eq('status','pending') 仍
    // 命中的那个请求拿到 1 行,输的拿到 0 行 → 只有赢家继续建群。
    const nowIso = new Date().toISOString()
    const { data: claimed, error: claimError } = await supabase
      .from('group_applications')
      .update({ status: 'approved', reviewed_at: nowIso, reviewed_by: user.id })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')

    if (claimError) {
      logger.error('Error claiming application for approval:', claimError)
      return NextResponse.json({ error: 'Approval failed' }, { status: 500 })
    }
    if (!claimed || claimed.length === 0) {
      // 并发请求已抢先处理(或已非 pending)。
      return NextResponse.json(
        { error: 'This application has already been processed' },
        { status: 400 }
      )
    }

    // 回滚领取:建群/加成员失败时,把申请退回 pending 让管理员可重试(补偿,非严格原子,
    // 但已远好于原 TOCTOU;竞态已被上面的条件 UPDATE 消除)。
    const rollbackClaim = async () => {
      await supabase
        .from('group_applications')
        .update({ status: 'pending', reviewed_at: null, reviewed_by: null })
        .eq('id', id)
        .eq('status', 'approved')
    }

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
      await rollbackClaim()
      return NextResponse.json({ error: 'Failed to create group' }, { status: 500 })
    }

    // 加申请人为组长(owner)。失败即致命:群不能没有 owner。补偿删群 + 退回 pending。
    const { error: memberError } = await supabase.from('group_members').insert({
      group_id: newGroup.id,
      user_id: application.applicant_id,
      role: 'owner',
    })

    if (memberError) {
      logger.error('Error adding group owner on approval — compensating:', memberError)
      await supabase.from('groups').delete().eq('id', newGroup.id)
      await rollbackClaim()
      return NextResponse.json({ error: 'Failed to finalize group' }, { status: 500 })
    }

    // 建群 + owner 都成功后,把 group_id 挂到已 approved 的申请上。
    const { error: linkError } = await supabase
      .from('group_applications')
      .update({ group_id: newGroup.id })
      .eq('id', id)
    if (linkError) {
      // 非致命:群与 owner 已就位,仅申请行少了 group_id 回链。记录即可,不回滚。
      logger.error('Approved group created but failed to link group_id on application:', linkError)
    }

    // 通知申请人本人:你的建群申请已通过(sendNotification 铁律,非 raw insert)。
    sendNotification(
      supabase,
      {
        user_id: application.applicant_id,
        type: 'system',
        title: 'Group approved',
        message: `Your group "${groupName}" has been approved`,
        link: `/groups/${newGroup.id}`,
        reference_id: newGroup.id,
      },
      'group-approved'
    )

    // 实时 ops 告警 (fire-and-forget, Telegram)
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
