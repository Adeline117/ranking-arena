import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// 检查是否是管理员
async function isAdmin(supabase: SupabaseClient, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  
  return profile?.role === 'admin'
}

// 获取所有小组信息修改申请（管理员）
export async function GET(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
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

    // 检查是否是管理员
    if (!await isAdmin(supabase, user.id)) {
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
