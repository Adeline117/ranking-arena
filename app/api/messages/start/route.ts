/**
 * 开始新对话 API
 * POST: 创建或获取与指定用户的会话
 *
 * SECURITY: Requires authentication. senderId is derived from authenticated user's
 * session, preventing users from starting conversations as other users.
 */

import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { traceMessage } from '@/lib/utils/logger'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

// Zod schema for POST /api/messages/start
const StartConversationSchema = z.object({
  receiverId: z.string().uuid('Invalid receiver ID'),
})

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  try {
    const rateLimitResponse = await checkRateLimit(request, RateLimitPresets.write)
    if (rateLimitResponse) return rateLimitResponse

    // SECURITY: Require authentication
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json(
        { error: 'Please log in first', error_code: 'NOT_AUTHENTICATED' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const parsed = StartConversationSchema.safeParse(body)
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'Invalid input', error_code: 'VALIDATION_ERROR', details: parsed.error.flatten() },
        { status: 400 }
      )
    }
    const { receiverId } = parsed.data

    // SECURITY: Use authenticated user's ID as sender, ignoring any client-provided senderId.
    const senderId = user.id

    if (senderId === receiverId) {
      return NextResponse.json(
        { error: 'Cannot send message to yourself', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

    const supabase = getSupabaseAdmin() as SupabaseClient

    // Permission check via single RPC call (replaces multiple queries)
    const { data: permCheck, error: permError } = await supabase
      .rpc('check_dm_permission', { p_sender_id: senderId, p_receiver_id: receiverId })

    if (permError) {
      logger.error('[Start Message API] check_dm_permission RPC error:', permError)
      return NextResponse.json({ error: 'Failed to check permissions' }, { status: 500 })
    }

    if (!permCheck) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const canMessage = permCheck.allowed !== false
    const isMutualFollow = permCheck.is_mutual || false

    let messageLimit = null
    if (permCheck.reason === 'LIMIT_REACHED') {
      messageLimit = { reached: true, sent: permCheck.sent_count || 3, max: 3 }
    } else if (permCheck.reason === 'DM_DISABLED') {
      return NextResponse.json(
        { error: 'This user has disabled direct messages', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    } else if (permCheck.reason === 'USER_NOT_FOUND') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    } else if (!canMessage && !permCheck.is_mutual) {
      // Non-mutual, under limit
      messageLimit = { reached: false, sent: permCheck.sent_count || 0, max: 3 }
    }

    // Get receiver handle for response
    const { data: receiverProfile } = await supabase
      .from('user_profiles')
      .select('handle')
      .eq('id', receiverId)
      .maybeSingle()

    // 获取或创建会话
    const orderedUser1 = senderId < receiverId ? senderId : receiverId
    const orderedUser2 = senderId < receiverId ? receiverId : senderId

    let { data: conversation } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id, created_at, updated_at')
      .eq('user1_id', orderedUser1)
      .eq('user2_id', orderedUser2)
      .maybeSingle()

    // 如果会话不存在，创建新会话
    if (!conversation) {
      const { data: newConv, error: convError } = await supabase
        .from('conversations')
        .insert({ user1_id: orderedUser1, user2_id: orderedUser2 })
        .select()
        .single()

      if (convError) {
        // 如果是并发创建导致的重复，再次查询
        if (convError.code === '23505') {
          const { data: existingConv } = await supabase
            .from('conversations')
            .select('id, user1_id, user2_id, created_at, updated_at')
            .eq('user1_id', orderedUser1)
            .eq('user2_id', orderedUser2)
            .single()
          conversation = existingConv
        } else {
          logger.error('[Start Message API] 创建会话错误:', convError)
          return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
        }
      } else {
        conversation = newConv
      }
    }

    if (!conversation) {
      return NextResponse.json({ error: 'Unable to create conversation' }, { status: 500 })
    }

    // 追踪会话创建/获取
    traceMessage({
      event: 'conversation_created',
      conversationId: conversation.id,
      senderId,
      receiverId,
      metadata: { isMutualFollow },
    })

    return NextResponse.json({
      conversation_id: conversation.id,
      can_message: canMessage,
      is_mutual_follow: isMutualFollow,
      message_limit: messageLimit,
      receiver_handle: receiverProfile?.handle || null
    })
  } catch (error: unknown) {
    logger.error('[Start Message API] 错误:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
