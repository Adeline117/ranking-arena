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
  
  return (profile as { role?: string } | null)?.role === 'admin'
}

// 拒绝小组申请
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    
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

    // 解析请求体获取拒绝原因
    const body = await request.json().catch(() => ({}))
    const { reason } = body

    // 获取申请信息
    const { data: application, error: fetchError } = await supabase
      .from('group_applications')
      .select('*')
      .eq('id', id)
      .single()

    if (fetchError || !application) {
      return NextResponse.json({ error: '申请不存在' }, { status: 404 })
    }

    if (application.status !== 'pending') {
      return NextResponse.json({ error: '该申请已被处理' }, { status: 400 })
    }

    // 更新申请状态为 rejected
    // 触发器会自动发送通知
    const { error: updateError } = await supabase
      .from('group_applications')
      .update({
        status: 'rejected',
        reject_reason: reason || null,
        reviewed_at: new Date().toISOString(),
        reviewed_by: user.id
      })
      .eq('id', id)

    if (updateError) {
      console.error('Error rejecting application:', updateError)
      return NextResponse.json({ error: '拒绝失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: '已拒绝该小组申请'
    })

  } catch (error) {
    console.error('Error rejecting application:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

