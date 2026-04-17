/**
 * 帖子置顶 API
 * POST /api/posts/[id]/pin - 切换帖子置顶状态
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id: postId } = await context.params

  const handler = withAuth(
    async ({ user, supabase }) => {
      // 获取帖子，验证是否是作者
      const { data: post, error: postError } = await supabase
        .from('posts')
        .select('id, author_id, is_pinned, group_id')
        .eq('id', postId)
        .single()

      if (postError || !post) {
        return NextResponse.json(
          { success: false, error: 'Post not found' },
          { status: 404 }
        )
      }

      // Check authorization: author OR group admin/owner
      let authorized = post.author_id === user.id

      if (!authorized && post.group_id) {
        const { data: membership } = await supabase
          .from('group_members')
          .select('role')
          .eq('group_id', post.group_id)
          .eq('user_id', user.id)
          .maybeSingle()

        if (membership?.role === 'owner' || membership?.role === 'admin') {
          authorized = true
        }
      }

      if (!authorized) {
        return NextResponse.json(
          { success: false, error: 'No permission to pin this post' },
          { status: 403 }
        )
      }

      // 切换置顶状态
      const newPinnedState = !post.is_pinned

      // If pinning, unpin other posts FIRST to prevent multiple pinned posts (race condition fix)
      if (newPinnedState) {
        if (post.group_id) {
          const { error: unpinError } = await supabase
            .from('posts')
            .update({ is_pinned: false })
            .eq('group_id', post.group_id)
            .eq('is_pinned', true)
            .neq('id', postId)

          if (unpinError) {
            logger.error('Failed to unpin other posts:', unpinError)
          }
        } else {
          const { error: unpinError } = await supabase
            .from('posts')
            .update({ is_pinned: false })
            .eq('author_id', user.id)
            .eq('is_pinned', true)
            .neq('id', postId)

          if (unpinError) {
            logger.error('Failed to unpin other posts:', unpinError)
          }
        }
      }

      // Now pin/unpin the target post
      const { error: updateError } = await supabase
        .from('posts')
        .update({ is_pinned: newPinnedState })
        .eq('id', postId)

      if (updateError) {
        throw new Error('Failed to update pin status: ' + updateError.message)
      }

      return success({
        is_pinned: newPinnedState,
        message: newPinnedState ? 'Pinned' : 'Unpinned',
      })
    },
    { name: 'posts-pin', rateLimit: 'sensitive' }
  )

  return handler(request)
}
