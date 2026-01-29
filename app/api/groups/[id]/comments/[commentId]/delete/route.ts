import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

// 检查用户是否是小组管理员或组长
async function canManageGroup(
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
  
  return data?.role === 'owner' || data?.role === 'admin'
}

// 删除评论（软删除）
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  try {
    const { id: groupId, commentId } = await params
    
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

    // 检查权限
    if (!await canManageGroup(supabase, groupId, user.id)) {
      return NextResponse.json({ error: '无权限' }, { status: 403 })
    }

    // 获取评论信息，检查是否属于此小组的帖子
    const { data: commentData } = await supabase
      .from('comments')
      .select('id, post_id, deleted_at')
      .eq('id', commentId)
      .single()

    if (!commentData) {
      return NextResponse.json({ error: '评论不存在' }, { status: 404 })
    }

    if (commentData.deleted_at) {
      return NextResponse.json({ error: '评论已被删除' }, { status: 400 })
    }

    // 检查帖子是否属于此小组
    const { data: postData } = await supabase
      .from('posts')
      .select('group_id')
      .eq('id', commentData.post_id)
      .single()

    if (!postData || postData.group_id !== groupId) {
      return NextResponse.json({ error: '评论不属于此小组' }, { status: 400 })
    }

    // 软删除评论
    const { error: updateError } = await supabase
      .from('comments')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: user.id,
        delete_reason: '管理员删除'
      })
      .eq('id', commentId)

    if (updateError) {
      console.error('Delete comment error:', updateError)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error: unknown) {
    console.error('Delete comment error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
