import { NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

// 检查是否是管理员
async function isAdmin(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()

  return (profile as { role?: string } | null)?.role === 'admin'
}

// 管理员获取待审核的申请列表
export const GET = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // 检查是否是管理员
    if (!(await isAdmin(supabase, user.id))) {
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
