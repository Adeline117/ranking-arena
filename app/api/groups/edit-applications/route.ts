import { NextRequest, NextResponse } from 'next/server'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import { verifyAdmin } from '@/lib/admin/auth'

// 获取所有小组信息修改申请（管理员）
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const supabase = getSupabaseAdmin()

    // SECURITY: use verifyAdmin so ADMIN_EMAILS env allowlist is enforced in
    // production (matches /api/admin/* gating). Replaces a DB-only role check
    // that would have bypassed the operational whitelist.
    const admin = await verifyAdmin(supabase, request.headers.get('Authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // 获取所有待审核的申请
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'pending'

    const { data: applications, error } = await supabase
      .from('group_edit_applications')
      .select(`
        *,
        group:groups!group_edit_applications_group_id_fkey(id, name, name_en),
        applicant:user_profiles!group_edit_applications_applicant_id_fkey(handle, avatar_url)
      `)
      .eq('status', status)
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
