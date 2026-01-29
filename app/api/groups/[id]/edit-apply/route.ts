import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查用户是否是小组组长（兼容旧数据：admin + 创建者也视为组长）
async function isGroupOwner(
  supabase: SupabaseClient<any>,
  groupId: string,
  userId: string
): Promise<boolean> {
  const { data: memberData } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()

  if (memberData?.role === 'owner') return true

  // 兼容旧数据：如果用户是 admin 且是小组创建者，也视为组长
  if (memberData?.role === 'admin') {
    const { data: groupData } = await supabase
      .from('groups')
      .select('created_by')
      .eq('id', groupId)
      .single()

    if (groupData?.created_by === userId) return true
  }

  return false
}

// 提交小组信息修改申请
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: groupId } = await params
    
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

    // 只有组长可以提交修改申请
    if (!await isGroupOwner(supabase, groupId, user.id)) {
      return NextResponse.json({ error: '只有组长可以修改小组信息' }, { status: 403 })
    }

    // 检查是否已有待审核的修改申请
    const { data: existingApp } = await supabase
      .from('group_edit_applications')
      .select('id')
      .eq('group_id', groupId)
      .eq('status', 'pending')
      .maybeSingle()

    if (existingApp) {
      return NextResponse.json({ error: '您已有待审核的修改申请，请等待审核结果' }, { status: 400 })
    }

    let body: {
      name?: string
      name_en?: string
      description?: string
      description_en?: string
      avatar_url?: string
      rules_json?: unknown
      rules?: string
      role_names?: unknown
      is_premium_only?: boolean
    }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: '请求格式错误' }, { status: 400 })
    }
    const {
      name,
      name_en,
      description,
      description_en,
      avatar_url,
      rules_json,
      rules,
      role_names,
      is_premium_only
    } = body

    // 验证
    if (name && name.length > 50) {
      return NextResponse.json({ error: '小组名称不能超过50个字符' }, { status: 400 })
    }

    if (description && description.length > 500) {
      return NextResponse.json({ error: '小组简介不能超过500个字符' }, { status: 400 })
    }

    // 创建修改申请
    const { data: application, error: insertError } = await supabase
      .from('group_edit_applications')
      .insert({
        group_id: groupId,
        applicant_id: user.id,
        name: name || null,
        name_en: name_en || null,
        description: description || null,
        description_en: description_en || null,
        avatar_url: avatar_url || null,
        rules_json: rules_json || null,
        rules: rules || null,
        role_names: role_names || null,
        is_premium_only: is_premium_only ?? null,
        status: 'pending'
      })
      .select()
      .single()

    if (insertError) {
      console.error('Create edit application error:', insertError)
      return NextResponse.json({ error: '提交失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: '修改申请已提交，请等待管理员审核',
      application
    })

  } catch (error: unknown) {
    console.error('Edit apply error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// 获取小组的修改申请列表（组长可查看）
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: groupId } = await params
    
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

    // 检查是否是组长
    if (!await isGroupOwner(supabase, groupId, user.id)) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    const { data: applications, error } = await supabase
      .from('group_edit_applications')
      .select('*')
      .eq('group_id', groupId)
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
