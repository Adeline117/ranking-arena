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

// 删除帖子（软删除）
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; postId: string }> }
) {
  try {
    const { id: groupId, postId } = await params
    
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

    // 检查帖子是否属于此小组
    const { data: postData } = await supabase
      .from('posts')
      .select('id, group_id, deleted_at, author_id, title')
      .eq('id', postId)
      .single()

    if (!postData) {
      return NextResponse.json({ error: '帖子不存在' }, { status: 404 })
    }

    if (postData.group_id !== groupId) {
      return NextResponse.json({ error: '帖子不属于此小组' }, { status: 400 })
    }

    if (postData.deleted_at) {
      return NextResponse.json({ error: '帖子已被删除' }, { status: 400 })
    }

    // 软删除帖子
    const { error: updateError } = await supabase
      .from('posts')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: user.id,
        delete_reason: '管理员删除'
      })
      .eq('id', postId)

    if (updateError) {
      console.error('Delete post error:', updateError)
      return NextResponse.json({ error: '删除失败' }, { status: 500 })
    }

    // Notify the post author
    if (postData.author_id && postData.author_id !== user.id) {
      const { error: notifyError } = await supabase
        .from('notifications')
        .insert({
          user_id: postData.author_id,
          type: 'system' as const,
          title: '帖子被删除',
          message: `您的帖子「${postData.title || ''}」已被小组管理员删除`,
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: postId,
        })

      if (notifyError) {
        console.error('Notification error:', notifyError)
      }
    }

    return NextResponse.json({ success: true })

  } catch (error) {
    console.error('Delete post error:', error)
    return NextResponse.json({ error: '服务器错误' }, { status: 500 })
  }
}
