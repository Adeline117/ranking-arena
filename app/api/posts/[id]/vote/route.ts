/**
 * 帖子投票 API
 * POST /api/posts/[id]/vote - 投票（看涨/看跌/观望）
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { PostInteractionMutationError, togglePostVote } from '@/lib/data/posts'
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

    const postId = z.string().uuid().safeParse(id)
    if (!postId.success) {
      return NextResponse.json({ error: 'Invalid post ID' }, { status: 400 })
    }

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
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
    let result
    try {
      result = await togglePostVote(supabase, postId.data, user.id, choice)
    } catch (error) {
      if (error instanceof PostInteractionMutationError) {
        if (error.kind === 'not_found') {
          return NextResponse.json({ error: 'Post not found' }, { status: 404 })
        }
        if (error.kind === 'invalid') {
          return NextResponse.json({ error: 'Invalid vote request' }, { status: 400 })
        }
      }
      throw error
    }

    return NextResponse.json({
      success: true,
      data: {
        action: result.action,
        vote: result.vote,
        poll: result.poll,
      },
    })
  },
  { name: 'posts/vote', rateLimit: 'write' }
)
