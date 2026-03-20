import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { socialFeatureGuard } from '@/lib/features'
import { getSupabaseAdmin } from '@/lib/supabase/server'

// 检查用户是否是小组管理员或组长
async function canManageGroup(
  supabase: SupabaseClient,
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
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId, commentId } = await params
    
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

    // 检查权限
    if (!await canManageGroup(supabase, groupId, user.id)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    // 获取评论信息，检查是否属于此小组的帖子
    const { data: commentData } = await supabase
      .from('comments')
      .select('id, post_id, deleted_at')
      .eq('id', commentId)
      .single()

    if (!commentData) {
      return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
    }

    if (commentData.deleted_at) {
      return NextResponse.json({ error: 'Comment already deleted' }, { status: 400 })
    }

    // 检查帖子是否属于此小组
    const { data: postData } = await supabase
      .from('posts')
      .select('group_id')
      .eq('id', commentData.post_id)
      .single()

    if (!postData || postData.group_id !== groupId) {
      return NextResponse.json({ error: 'Comment does not belong to this group' }, { status: 400 })
    }

    // 软删除评论
    const { error: updateError } = await supabase
      .from('comments')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: user.id,
        delete_reason: 'Deleted by admin'
      })
      .eq('id', commentId)

    if (updateError) {
      logger.error('Delete comment error:', updateError)
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
    }

    return NextResponse.json({ success: true })

  } catch (error: unknown) {
    logger.error('Delete comment error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
