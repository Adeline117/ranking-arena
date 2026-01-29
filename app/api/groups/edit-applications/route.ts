import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查是否是管理员
async function isAdmin(supabase: SupabaseClient<any>, userId: string): Promise<boolean> {
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('role')
    .eq('id', userId)
    .maybeSingle()
  
  return profile?.role === 'admin'
}

// 获取所有小组信息修改申请（管理员）
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

    // 检查是否是管理员
    if (!await isAdmin(supabase, user.id)) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
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
      console.error('Fetch edit applications error:', error)
      return NextResponse.json({ error: '获取失败' }, { status: 500 })
    }

    return NextResponse.json({ applications })

  } catch (error: unknown) {
    console.error('Get edit applications error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
