import { NextRequest, NextResponse } from 'next/server'
import { SupabaseClient } from '@supabase/supabase-js'
import { withAuth } from '@/lib/api/middleware'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import {
  CommentMutationRolloutError,
  moderateCommentHardDeleteWithRollout,
} from '@/lib/data/comment-mutation-rollout'

// 检查用户是否是小组管理员或组长
async function canManageGroup(
  supabase: SupabaseClient,
  groupId: string,
  userId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from('group_members')
    .select('role')
    .eq('group_id', groupId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) {
    logger.error('[canManageGroup] query failed', { code: error.code })
    throw error
  }

  return data?.role === 'owner' || data?.role === 'admin'
}

// 删除评论（软删除）
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; commentId: string }> }
) {
  const { id: groupId, commentId } = await params

  const handler = withAuth(
    async ({ user, supabase }) => {
      const guard = socialFeatureGuard()
      if (guard) return guard

      // 检查权限
      if (!(await canManageGroup(supabase, groupId, user.id))) {
        return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
      }

      // 获取评论信息，检查是否属于此小组的帖子
      const { data: commentData, error: commentError } = await supabase
        .from('comments')
        .select('id, post_id')
        .eq('id', commentId)
        .maybeSingle()

      if (commentError) {
        logger.error('Comment lookup failed', { code: commentError.code })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      if (!commentData) {
        return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
      }

      // 检查帖子是否属于此小组
      const { data: postData, error: postError } = await supabase
        .from('posts')
        .select('group_id')
        .eq('id', commentData.post_id)
        .maybeSingle()

      if (postError) {
        logger.error('Comment post lookup failed', { code: postError.code })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      if (!postData || postData.group_id !== groupId) {
        return NextResponse.json(
          { error: 'Comment does not belong to this group' },
          { status: 400 }
        )
      }

      let result
      try {
        result = await moderateCommentHardDeleteWithRollout(supabase, {
          commentId,
          expectedPostId: commentData.post_id,
          actorId: user.id,
          reason: 'Deleted by group administrator',
        })
      } catch (error: unknown) {
        if (error instanceof CommentMutationRolloutError && error.kind === 'not_found') {
          return NextResponse.json({ error: 'Comment not found' }, { status: 404 })
        }
        logger.error('Delete comment failed', {
          code: error instanceof CommentMutationRolloutError ? error.databaseCode : undefined,
        })
        return NextResponse.json({ error: 'Delete failed' }, { status: 500 })
      }

      return NextResponse.json({
        success: true,
        affected_count: result.affected_count,
        comment_count: result.comment_count,
      })
    },
    { name: 'group-comment-delete', rateLimit: 'sensitive' }
  )

  return handler(request)
}
