/**
 * 帖子投票 API
 * POST /api/posts/[id]/vote - 投票（看涨/看跌/观望）
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  handleError,
  validateEnum,
} from '@/lib/api'
import { togglePostVote, getPostById } from '@/lib/data/posts'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'

type RouteContext = { params: Promise<{ id: string }> }

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    const { id } = await context.params
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin()

    const body = await request.json()
    const choice = validateEnum(
      body.choice,
      ['bull', 'bear', 'wait'] as const,
      { required: true, fieldName: 'choice' }
    )!

    // 执行投票操作
    const result = await togglePostVote(supabase, id, user.id, choice)

    // 获取更新后的帖子信息
    const post = await getPostById(supabase, id)

    return success({
      action: result.action,
      vote: result.vote,
      poll: {
        bull: post?.poll_bull || 0,
        bear: post?.poll_bear || 0,
        wait: post?.poll_wait || 0,
      },
    })
  } catch (error: unknown) {
    return handleError(error, 'posts/[id]/vote')
  }
}
