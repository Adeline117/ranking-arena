import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查是否是管理员
 
async function isAdmin(supabase: SupabaseClient<any>, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  
  return (profile as { role?: string } | null)?.role === 'admin'
}

// 管理员获取待审核的申请列表
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: 'Not logged in' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: 'Authentication failed' }, { status: 401 })
    }

    // 检查是否是管理员
    if (!await isAdmin(supabase, user.id)) {
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

  } catch (error: unknown) {
    logger.error('Error fetching applications:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

