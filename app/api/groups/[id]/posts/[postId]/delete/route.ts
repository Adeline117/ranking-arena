import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { fireAndForget } from '@/lib/utils/logger'
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

// 删除帖子（软删除）
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; postId: string }> }
) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResp) return rateLimitResp

  try {
    const { id: groupId, postId } = await params
    
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

    // 检查帖子是否属于此小组
    const { data: postData } = await supabase
      .from('posts')
      .select('id, group_id, deleted_at, author_id, title')
      .eq('id', postId)
      .single()

    if (!postData) {
      return NextResponse.json({ error: 'Post not found' }, { status: 404 })
    }

    if (postData.group_id !== groupId) {
      return NextResponse.json({ error: 'Post does not belong to this group' }, { status: 400 })
    }

    if (postData.deleted_at) {
      return NextResponse.json({ error: 'Post has been deleted' }, { status: 400 })
    }

    // 软删除帖子
    const { error: updateError } = await supabase
      .from('posts')
      .update({
        deleted_at: new Date().toISOString(),
        deleted_by: user.id,
        delete_reason: 'Deleted by admin'
      })
      .eq('id', postId)

    if (updateError) {
      logger.error('Delete post error:', updateError)
      return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
    }

    // Notify the post author
    if (postData.author_id && postData.author_id !== user.id) {
      const { error: notifyError } = await supabase
        .from('notifications')
        .insert({
          user_id: postData.author_id,
          type: 'system' as const,
          title: 'Post deleted',
          message: `Your post "${postData.title || ''}" was deleted by group admin`,
          link: `/groups/${groupId}`,
          actor_id: user.id,
          reference_id: postId,
        })

      if (notifyError) {
        logger.error('Notification error:', notifyError)
      }
    }

    // Audit log (fire-and-forget)
    fireAndForget(
      supabase.from('group_audit_log').insert({
        group_id: groupId,
        actor_id: user.id,
        action: 'delete_post',
        target_id: postId,
        details: { reason: null }
      }).then(),
      'Group audit log: delete_post'
    )

    return NextResponse.json({ success: true })

  } catch (error: unknown) {
    logger.error('Delete post error:', error)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
