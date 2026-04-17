/**
 * 打赏 API
 * POST /api/tip - 给帖子打赏
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { badRequest, serverError } from '@/lib/api/response'
import { validateString } from '@/lib/api/validation'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('tip-api')

export const runtime = 'nodejs'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return badRequest('Invalid JSON body')
    }

    const post_id = validateString(body.post_id, {
      required: true,
      fieldName: 'post_id'
    })
    const amount_cents = Number(body.amount_cents ?? 100)

    if (!post_id) {
      return badRequest('Missing post_id parameter')
    }

    if (amount_cents <= 0 || amount_cents > 100000) {
      return badRequest('Invalid tip amount')
    }

    // 检查帖子是否存在
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('id', post_id)
      .maybeSingle()

    if (!post) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_FOUND', message: 'Post not found' } },
        { status: 404 }
      )
    }

    // 不能给自己的帖子打赏
    if (post.author_id === user.id) {
      return badRequest('Cannot tip your own post')
    }

    // 写入 gifts 表
    const { error: insertError } = await supabase.from('gifts').insert({
      post_id,
      from_user_id: user.id,
      to_user_id: post.author_id,
      amount_cents,
    })

    if (insertError) {
      logger.error('Insert error', { error: insertError, postId: post_id, userId: user.id, amountCents: amount_cents })
      return serverError('Tip failed: ' + insertError.message)
    }

    return NextResponse.json({
      success: true,
      data: { message: 'Tip successful' },
    })
  },
  {
    name: 'tip',
    rateLimit: 'sensitive',
  }
)
