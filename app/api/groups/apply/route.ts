import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

export async function POST(request: NextRequest) {
  try {
    // 验证用户身份
    const authHeader = request.headers.get('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      return NextResponse.json({ error: '未登录' }, { status: 401 })
    }

    const token = authHeader.slice(7)
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // 验证 token
    const { data: { user }, error: authError } = await supabase.auth.getUser(token)
    if (authError || !user) {
      return NextResponse.json({ error: '身份验证失败' }, { status: 401 })
    }

    // 解析请求体
    const body = await request.json()
    const { name, name_en, description, description_en, avatar_url, role_names } = body

    // 验证必填字段
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return NextResponse.json({ error: '小组名称不能为空' }, { status: 400 })
    }

    if (name.trim().length > 50) {
      return NextResponse.json({ error: '小组名称不能超过50个字符' }, { status: 400 })
    }

    if (description && description.length > 500) {
      return NextResponse.json({ error: '小组简介不能超过500个字符' }, { status: 400 })
    }

    // 检查是否已有待审核的申请
    const { data: existingApplication } = await supabase
      .from('group_applications')
      .select('id')
      .eq('applicant_id', user.id)
      .eq('status', 'pending')
      .maybeSingle()

    if (existingApplication) {
      return NextResponse.json({ error: '您已有待审核的小组申请，请等待审核结果' }, { status: 400 })
    }

    // 检查小组名是否已存在
    const { data: existingGroup } = await supabase
      .from('groups')
      .select('id')
      .eq('name', name.trim())
      .maybeSingle()

    if (existingGroup) {
      return NextResponse.json({ error: '该小组名称已被使用' }, { status: 400 })
    }

    // 默认角色名称（admin 包含组长和管理员）
    const defaultRoleNames = {
      admin: { zh: '管理员', en: 'Admin' },
      member: { zh: '成员', en: 'Member' }
    }

    // 合并用户提供的角色名称
    const finalRoleNames = role_names ? {
      admin: { ...defaultRoleNames.admin, ...role_names.admin },
      member: { ...defaultRoleNames.member, ...role_names.member }
    } : defaultRoleNames

    // 创建申请
    const { data: application, error: insertError } = await supabase
      .from('group_applications')
      .insert({
        applicant_id: user.id,
        name: name.trim(),
        name_en: name_en?.trim() || null,
        description: description?.trim() || null,
        description_en: description_en?.trim() || null,
        avatar_url: avatar_url || null,
        role_names: finalRoleNames,
        status: 'pending'
      })
      .select()
      .single()

    if (insertError) {
      console.error('Error creating application:', insertError)
      return NextResponse.json({ error: '申请提交失败' }, { status: 500 })
    }

    return NextResponse.json({
      success: true,
      message: '申请已提交，请等待管理员审核',
      application
    })

  } catch (error) {
    console.error('Error in group application:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// 获取当前用户的申请列表
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

    // 获取用户的所有申请
    const { data: applications, error } = await supabase
      .from('group_applications')
      .select('*')
      .eq('applicant_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('Error fetching applications:', error)
      return NextResponse.json({ error: '获取申请列表失败' }, { status: 500 })
    }

    return NextResponse.json({ applications })

  } catch (error) {
    console.error('Error fetching applications:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

