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

    // NOTE: group_edit_applications.applicant_id references auth.users (not
    // public.user_profiles), so a PostgREST embed fails with PGRST200.
    // Two-step query: fetch applications (group embed has a real FK and is
    // fine), then look up applicant profiles by id and merge.
    const { data: applications, error } = await supabase
      .from('group_edit_applications')
      .select(
        `
        *,
        group:groups!group_edit_applications_group_id_fkey(id, name, name_en)
      `
      )
      .eq('status', status)
      .order('created_at', { ascending: false })

    if (error) {
      logger.error('Fetch edit applications error:', error)
      return NextResponse.json({ error: 'Fetch failed' }, { status: 500 })
    }

    const applicantIds = [
      ...new Set((applications || []).map((a) => a.applicant_id).filter(Boolean)),
    ]
    const { data: applicantProfiles } = applicantIds.length
      ? await supabase.from('user_profiles').select('id, handle, avatar_url').in('id', applicantIds)
      : { data: null }
    const profileById = new Map((applicantProfiles || []).map((p) => [p.id, p]))

    const applicationsWithApplicant = (applications || []).map((a) => {
      const profile = profileById.get(a.applicant_id)
      return {
        ...a,
        applicant: profile ? { handle: profile.handle, avatar_url: profile.avatar_url } : null,
      }
    })

    return NextResponse.json({ applications: applicationsWithApplicant })
  } catch (error: unknown) {
    logger.error('Get edit applications error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
