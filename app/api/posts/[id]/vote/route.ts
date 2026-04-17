/**
 * 帖子投票 API
 * POST /api/posts/[id]/vote - 投票（看涨/看跌/观望）
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { togglePostVote, getPostById } from '@/lib/data/posts'
import { socialFeatureGuard } from '@/lib/features'

// Zod schema for POST /api/posts/[id]/vote
const PostVoteSchema = z.object({
  choice: z.enum(['bull', 'bear', 'wait'], { message: 'choice must be bull, bear, or wait' }),
})

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    // Extract post id from URL path
    const url = new URL(request.url)
    const pathParts = url.pathname.split('/')
    const postsIdx = pathParts.indexOf('posts')
    const id = pathParts[postsIdx + 1]

    if (!id) {
      return NextResponse.json(
        { error: 'Missing post ID' },
        { status: 400 }
      )
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body' },
        { status: 400 }
      )
    }

    const parsed = PostVoteSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { choice } = parsed.data

    // 执行投票操作
    const result = await togglePostVote(supabase, id, user.id, choice)

    // 获取更新后的帖子信息
    const post = await getPostById(supabase, id)

    return NextResponse.json({
      success: true,
      data: {
        action: result.action,
        vote: result.vote,
        poll: {
          bull: post?.poll_bull || 0,
          bear: post?.poll_bear || 0,
          wait: post?.poll_wait || 0,
        },
      },
    })
  },
  { name: 'posts/vote', rateLimit: 'write' }
)
