/**
 * 帖子点赞 API
 * POST /api/posts/[id]/like - 点赞/取消点赞
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateEnum,
} from '@/lib/api'
import { togglePostReaction, getPostById } from '@/lib/data/posts'
import { deleteServerCacheByPrefix } from '@/lib/utils/server-cache'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const { id } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const reactionType = validateEnum(
      body.reaction_type || 'up',
      ['up', 'down'] as const,
      { fieldName: 'reaction_type' }
    ) ?? 'up'

    // 执行点赞/踩操作
    const result = await togglePostReaction(supabase, id, user.id, reactionType)

    // 清除帖子列表缓存
    deleteServerCacheByPrefix('posts:')

    // 获取更新后的帖子信息
    const post = await getPostById(supabase, id)

    return success({
      action: result.action,
      reaction: result.reaction,
      like_count: post?.like_count || 0,
      dislike_count: post?.dislike_count || 0,
    })
  } catch (error) {
    return handleError(error, 'posts/[id]/like')
  }
}
