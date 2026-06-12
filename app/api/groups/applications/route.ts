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
    // NOTE: group_applications.applicant_id references auth.users (not
    // public.user_profiles), so a PostgREST embed fails with PGRST200.
    // Two-step query: fetch applications, then look up applicant profiles.
    let query = supabase
      .from('group_applications')
      .select('*')
      .order('created_at', { ascending: false })

    if (status !== 'all') {
      query = query.eq('status', status)
    }

    const { data: applications, error } = await query

    if (error) {
      logger.error('Error fetching applications:', error)
      return NextResponse.json({ error: 'Failed to fetch application list' }, { status: 500 })
    }

    const applicantIds = [
      ...new Set((applications || []).map((a) => a.applicant_id).filter(Boolean)),
    ]
    const { data: applicantProfiles } = applicantIds.length
      ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', applicantIds)
      : { data: null }
    const profileById = new Map((applicantProfiles || []).map((p) => [p.id, p]))

    const applicationsWithApplicant = (applications || []).map((a) => ({
      ...a,
      applicant: profileById.get(a.applicant_id) ?? null,
    }))

    return NextResponse.json({ applications: applicationsWithApplicant })
  },
  { name: 'groups-applications-get', rateLimit: 'read' }
)
