import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { verifyAdmin } from '@/lib/admin/auth'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

// 管理员获取待审核的申请列表
export const GET = withAuth(
  async ({ supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // SECURITY: use verifyAdmin so ADMIN_EMAILS env allowlist is enforced in
    // production — matches /api/admin/* gating. A DB-only role check here
    // would let anyone with the ability to flip user_profiles.role to 'admin'
    // (RLS bug, compromised migration, DB insider) gain access without being
    // on the operational whitelist.
    const admin = await verifyAdmin(supabase, request.headers.get('authorization'))
    if (!admin) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // 获取状态筛选参数
    const { searchParams } = new URL(request.url)
    const status = searchParams.get('status') || 'pending'

    // 获取申请列表
    let query = supabase
      .from('group_applications')
      .select(`
        *,
        applicant:user_profiles!applicant_id(id, handle, avatar_url)
      `)
      .order('created_at', { ascending: false })

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    const { data: applications, error } = await query

    if (error) {
      logger.error('Error fetching applications:', error)
      return NextResponse.json({ error: 'Failed to fetch application list' }, { status: 500 })
    }

    return NextResponse.json({ applications })
  },
  { name: 'groups-applications-get', rateLimit: 'read' }
)
