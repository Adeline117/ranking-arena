import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查用户是否是小组组长
async function isGroupOwner(
  supabase: SupabaseClient<any>, 
  groupId: string, 
  userId: string
): Promise<boolean> {
  const { data } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()
  
  return data?.role === 'owner'
}

// 设置成员角色
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

    // 只有组长可以设置角色
    if (!await isGroupOwner(supabase, groupId, user.id)) {
      return NextResponse.json({ error: '只有组长可以设置成员角色' }, { status: 403 })
    }

    // 不能修改自己的角色
    if (targetUserId === user.id) {
      return NextResponse.json({ error: '不能修改自己的角色' }, { status: 400 })
    }

    // 检查目标用户是否是成员
    const { data: memberData } = await supabase
      .from('group_members')
      .select('role')
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)
      .maybeSingle()

    if (!memberData) {
      return NextResponse.json({ error: '目标用户不是小组成员' }, { status: 404 })
    }

    // 不能修改组长角色
    if (memberData.role === 'owner') {
      return NextResponse.json({ error: '不能修改组长角色' }, { status: 400 })
    }

    const body = await request.json()
    const { role } = body

    // 验证角色值
    if (!['admin', 'member'].includes(role)) {
      return NextResponse.json({ error: '无效的角色' }, { status: 400 })
    }

    // 更新角色
    const { error: updateError } = await supabase
      .from('group_members')
      .update({ role })
      .eq('group_id', groupId)
      .eq('user_id', targetUserId)

    if (updateError) {
      logger.error('Set role error:', updateError)
      return NextResponse.json({ error: '设置角色失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true, role })

  } catch (error: unknown) {
    logger.error('Set role error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
