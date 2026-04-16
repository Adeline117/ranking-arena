import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'

// 拒绝小组信息修改申请
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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

    // 获取申请信息
    const { data: application, error: fetchError } = await supabase
      .from('group_edit_applications')
      .select('id, status')
      .eq('id', id)
      .single()

    if (fetchError || !application) {
      return NextResponse.json({ error: 'Application not found' }, { status: 404 })
    }

    if (application.status !== 'pending') {
      return NextResponse.json({ error: 'This application has already been processed' }, { status: 400 })
    }

    const body = await request.json()
    const { reason } = body

    // 更新申请状态为 rejected
    // 触发器会发送通知
    const { error: updateError } = await supabase
      .from('group_edit_applications')
      .update({
        status: 'rejected',
        reject_reason: reason || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id
      })
      .eq('id', id)

    if (updateError) {
      logger.error('Error rejecting edit application:', updateError)
      return NextResponse.json({ error: 'Rejection failed' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: 'Edit application rejected'
    })

  } catch (error: unknown) {
    logger.error('Error rejecting edit application:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
