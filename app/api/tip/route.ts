/**
 * 打赏 API
 * POST /api/tip - 给帖子打赏
 */

import { NextRequest } from 'next/server'
import {
  getSupabaseAdmin,
  requireAuth,
  success,
  error,
  handleError,
  validateString,
  checkRateLimit,
  RateLimitPresets,
} from '@/lib/api'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('tip-api')

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  // 敏感操作限流：每分钟 10 次
  const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.sensitive)
  if (rateLimitResponse) return rateLimitResponse

  try {
    // 验证用户身份
    const user = await requireAuth(request)
    const supabase = getSupabaseAdmin() as SupabaseClient
    
    const body = await request.json()

    const post_id = validateString(body.post_id, { 
      required: true, 
      fieldName: 'post_id' 
    })
    const amount_cents = Number(body.amount_cents ?? 100)

    if (!post_id) {
      return error('Missing post_id parameter', 400)
    }

    if (amount_cents <= 0 || amount_cents > 100000) {
      return error('Invalid tip amount', 400)
    }

    // 检查帖子是否存在
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('id', post_id)
      .maybeSingle()

    if (!post) {
      return error('Post not found', 404)
    }

    // 不能给自己的帖子打赏
    if (post.author_id === user.id) {
      return error('Cannot tip your own post', 400)
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
      return error('Tip failed: ' + insertError.message, 500)
    }

    return success({ message: 'Tip successful' })
  } catch (e: unknown) {
    return handleError(e, 'tip POST')
  }
}
