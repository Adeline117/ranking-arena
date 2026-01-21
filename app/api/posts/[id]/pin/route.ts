/**
 * 帖子置顶 API
 * POST /api/posts/[id]/pin - 切换帖子置顶状态
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
} from '@/lib/api'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id: postId } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    // 获取帖子，验证是否是作者
    const { data: post, error: postError } = await supabase
      .from('posts')
      .select('id, author_id, is_pinned')
      .eq('id', postId)
      .single()

    if (postError || !post) {
      throw new Error('帖子不存在')
    }

    if (post.author_id !== user.id) {
      throw new Error('只有作者可以置顶帖子')
    }

    // 切换置顶状态
    const newPinnedState = !post.is_pinned

    // 更新当前帖子的置顶状态（先执行主操作）
    const { error: updateError } = await supabase
      .from('posts')
      .update({ is_pinned: newPinnedState })
      .eq('id', postId)

    if (updateError) {
      throw new Error('更新置顶状态失败: ' + updateError.message)
    }

    // 如果成功置顶了，取消该用户其他帖子的置顶
    if (newPinnedState) {
      const { error: unpinError } = await supabase
        .from('posts')
        .update({ is_pinned: false })
        .eq('author_id', user.id)
        .eq('is_pinned', true)
        .neq('id', postId)  // 排除刚刚置顶的帖子

      if (unpinError) {
        // Log but don't fail - the main operation succeeded
        console.error('Failed to unpin other posts:', unpinError)
      }
    }

    return success({
      is_pinned: newPinnedState,
      message: newPinnedState ? '已置顶' : '已取消置顶',
    })
  } catch (error) {
    return handleError(error, 'posts/[id]/pin')
  }
}


