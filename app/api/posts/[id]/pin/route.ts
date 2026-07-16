/**
 * 帖子置顶 API
 * POST /api/posts/[id]/pin - 切换帖子置顶状态
 */

import { NextRequest, NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { success } from '@/lib/api/response'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'
import { canServiceActorReadPost } from '@/lib/data/service-post-audience'
import { z } from 'zod'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const { id: postId } = await context.params
  const parsedPostId = z.string().uuid().safeParse(postId)
  if (!parsedPostId.success) {
    return NextResponse.json({ success: false, error: 'Invalid post ID' }, { status: 400 })
  }

  const handler = withAuth(
    async ({ user, supabase }) => {
      if (!(await canServiceActorReadPost(supabase, parsedPostId.data, user.id))) {
        return NextResponse.json({ success: false, error: 'Post not found' }, { status: 404 })
      }

      // 获取帖子，验证是否是作者
      const { data: post, error: postError } = await supabase
        .from('posts')
        .select('id, author_id, is_pinned, group_id')
        .eq('id', parsedPostId.data)
        .single()

      if (postError || !post) {
        return NextResponse.json({ success: false, error: 'Post not found' }, { status: 404 })
      }

      // Check authorization: author OR group admin/owner
      let authorized = post.author_id === user.id

      if (!authorized && post.group_id) {
        const { data: membership, error: membershipError } = await supabase
          .from('group_members')
          .select('role')
          .eq('group_id', post.group_id)
          .eq('user_id', user.id)
          .maybeSingle()

        if (membershipError) {
          logger.error('Failed to check group pin authority:', membershipError)
          return NextResponse.json(
            { success: false, error: 'Could not verify pin permission' },
            { status: 500 }
          )
        }

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
            .neq('id', parsedPostId.data)

          if (unpinError) {
            logger.error('Failed to unpin other posts:', unpinError)
          }
        } else {
          const { error: unpinError } = await supabase
            .from('posts')
            .update({ is_pinned: false })
            .eq('author_id', user.id)
            .eq('is_pinned', true)
            .neq('id', parsedPostId.data)

          if (unpinError) {
            logger.error('Failed to unpin other posts:', unpinError)
          }
        }
      }

      // Now pin/unpin the target post
      const { error: updateError } = await supabase
        .from('posts')
        .update({ is_pinned: newPinnedState })
        .eq('id', parsedPostId.data)

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
