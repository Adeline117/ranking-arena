import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'
import { sendNotification } from '@/lib/data/notifications'

// 拒绝小组申请
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id } = await params

    const supabase = getSupabaseAdmin()

    // SECURITY: use verifyAdmin so ADMIN_EMAILS env allowlist is enforced in
    // production (matches /api/admin/* gating). Replaces a DB-only role check
    // that would have bypassed the operational whitelist.
    const admin = await verifyAdmin(supabase, request.headers.get('Authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }
    const user = { id: admin.id }

    // 解析请求体获取拒绝原因
    const body = await request.json().catch(() => ({}))
    const { reason } = body

    // 获取申请信息（含 applicant_id 用于通知）
    const { data: application, error: fetchError } = await supabase
      .from('group_applications')
      .select('id, status, applicant_id, name')
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

    // 更新申请状态为 rejected（不建群）。条件 UPDATE .eq('status','pending') 作为竞态门:
    // 只有一个并发请求命中 → 幂等,重复拒绝拿 0 行返回"已处理"。
    const { data: rejected, error: updateError } = await supabase
      .from('group_applications')
      .update({
        status: 'rejected',
        reject_reason: reason || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id,
      })
      .eq('id', id)
      .eq('status', 'pending')
      .select('id')

    if (updateError) {
      logger.error('Error rejecting application:', updateError)
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }
    if (!rejected || rejected.length === 0) {
      return NextResponse.json(
        { error: 'This application has already been processed' },
        { status: 400 }
      )
    }

    // 通知申请人本人:你的建群申请被拒(含原因)。sendNotification 铁律。
    sendNotification(
      supabase,
      {
        user_id: application.applicant_id,
        type: 'system',
        title: 'Group application rejected',
        message: reason
          ? `Your group "${application.name}" was not approved: ${reason}`
          : `Your group "${application.name}" was not approved`,
        reference_id: application.id,
      },
      'group-rejected'
    )

    return NextResponse.json({
      success: true,
      message: 'Group application rejected',
    })
  } catch (error: unknown) {
    logger.error('Error rejecting application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
