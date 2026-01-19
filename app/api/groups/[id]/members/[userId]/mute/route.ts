import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查用户是否是小组管理员或组长
async function getGroupRole(
  supabase: SupabaseClient<any>, 
  groupId: string, 
  userId: string
): Promise<'owner' | 'admin' | 'member' | null> {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()
  
  return data?.role as 'owner' | 'admin' | 'member' | null
}

// 禁言成员
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  try {
    const { id: groupId, userId: targetUserId } = await params
    
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

    // 检查操作者权限
    const operatorRole = await getGroupRole(supabase, groupId, user.id)
    if (!operatorRole || operatorRole === 'member') {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // 检查目标用户角色
    const targetRole = await getGroupRole(supabase, groupId, targetUserId)
    if (!targetRole) {
      return NextResponse.json({ error: '目标用户不是小组成员' }, { status: 404 })
    }

    // 管理员不能禁言组长或其他管理员
    if (operatorRole === 'admin' && (targetRole === 'owner' || targetRole === 'admin')) {
      return NextResponse.json({ error: '无权限禁言此用户' }, { status: 403 })
    }

    // 组长不能禁言自己
    if (operatorRole === 'owner' && targetUserId === user.id) {
      return NextResponse.json({ error: '不能禁言自己' }, { status: 400 })
    }

    const body = await request.json()
    const { muted_until, reason } = body

    // 更新禁言状态
    const { error: updateError } = await supabase
      .from('group_members')
      .update({
        muted_until,
        mute_reason: reason || null,
        muted_by: user.id
      })
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (updateError) {
      console.error('Mute error:', updateError)
      return NextResponse.json({ error: '禁言失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Mute error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}

// 解除禁言
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; userId: string }> }
) {
  try {
    const { id: groupId, userId: targetUserId } = await params
    
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

    // 检查操作者权限
    const operatorRole = await getGroupRole(supabase, groupId, user.id)
    if (!operatorRole || operatorRole === 'member') {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // 解除禁言
    const { error: updateError } = await supabase
      .from('group_members')
      .update({
        muted_until: null,
        mute_reason: null,
        muted_by: null
      })
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (updateError) {
      console.error('Unmute error:', updateError)
      return NextResponse.json({ error: '解除禁言失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Unmute error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
