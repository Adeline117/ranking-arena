/**
 * 开始新对话 API
 * POST: 创建或获取与指定用户的会话
 *
 * SECURITY: Requires authentication. senderId is derived from authenticated user's
 * session, preventing users from starting conversations as other users.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withAuth } from '@/lib/api/middleware'
import { traceMessage } from '@/lib/utils/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { socialFeatureGuard } from '@/lib/features'

// Zod schema for POST /api/messages/start
const StartConversationSchema = z.object({
  receiverId: z.string().uuid('Invalid receiver ID'),
})

const DmPermissionSchema = z
  .object({
    allowed: z.boolean(),
    reason: z.string().min(1).nullable().optional(),
    is_mutual: z.boolean().optional(),
    receiver_replied: z.boolean().optional(),
    sent_count: z.number().int().nonnegative().optional(),
  })
  .passthrough()

const ConversationSchema = z
  .object({
    id: z.string().uuid(),
    user1_id: z.string().uuid(),
    user2_id: z.string().uuid(),
    created_at: z.string().optional(),
  })
  .passthrough()

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body', error_code: 'VALIDATION_ERROR' },
        { status: 400 }
      )
    }

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

    // Permission check via single RPC call (replaces multiple queries)
    const { data: permCheck, error: permError } = await (supabase as SupabaseClient).rpc(
      'check_dm_permission',
      { p_sender_id: senderId, p_receiver_id: receiverId }
    )

    if (permError) {
      logger.error('[Start Message API] check_dm_permission RPC error:', permError)
      return NextResponse.json({ error: 'Failed to check permissions' }, { status: 500 })
    }

    const parsedPermission = DmPermissionSchema.safeParse(permCheck)
    if (
      !parsedPermission.success ||
      (parsedPermission.data.allowed && parsedPermission.data.reason != null) ||
      (!parsedPermission.data.allowed && !parsedPermission.data.reason) ||
      (parsedPermission.data.reason === 'LIMIT_REACHED' &&
        (parsedPermission.data.sent_count ?? 0) < 3)
    ) {
      logger.error('[Start Message API] Invalid check_dm_permission response:', permCheck)
      return NextResponse.json(
        { error: 'Failed to check permissions', error_code: 'PERMISSION_CHECK_FAILED' },
        { status: 500 }
      )
    }

    const permission = parsedPermission.data
    const canMessage = permission.allowed
    const isMutualFollow = permission.is_mutual === true

    let messageLimit = null
    if (permission.reason === 'LIMIT_REACHED') {
      messageLimit = { reached: true, sent: permission.sent_count!, max: 3 }
    } else if (permission.reason === 'DM_DISABLED') {
      return NextResponse.json(
        { error: 'This user has disabled direct messages', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    } else if (permission.reason === 'USER_NOT_FOUND') {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    } else if (!canMessage) {
      // BLOCKED, SENDER_UNAVAILABLE and future denial reasons must fail closed.
      // In particular, never create an empty conversation for blocked users.
      return NextResponse.json(
        { error: 'Permission denied', error_code: 'PERMISSION_DENIED' },
        { status: 403 }
      )
    } else if (!isMutualFollow && typeof permission.sent_count === 'number') {
      // Non-mutual sender with capacity remaining.
      messageLimit = { reached: false, sent: permission.sent_count, max: 3 }
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

    const { data: existingConversation, error: existingConversationError } = await supabase
      .from('conversations')
      .select('id, user1_id, user2_id, created_at')
      .eq('user1_id', orderedUser1)
      .eq('user2_id', orderedUser2)
      .maybeSingle()

    if (existingConversationError) {
      logger.error('[Start Message API] 查询会话错误:', existingConversationError)
      return NextResponse.json({ error: 'Failed to find conversation' }, { status: 500 })
    }

    let conversation: unknown = existingConversation

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
          const { data: existingConv, error: existingConvError } = await supabase
            .from('conversations')
            .select('id, user1_id, user2_id, created_at')
            .eq('user1_id', orderedUser1)
            .eq('user2_id', orderedUser2)
            .single()
          if (existingConvError) {
            logger.error('[Start Message API] 并发查询会话错误:', existingConvError)
            return NextResponse.json({ error: 'Failed to find conversation' }, { status: 500 })
          }
          conversation = existingConv
        } else {
          logger.error('[Start Message API] 创建会话错误:', convError)
          return NextResponse.json({ error: 'Failed to create conversation' }, { status: 500 })
        }
      } else {
        conversation = newConv
      }
    }

    const parsedConversation = ConversationSchema.safeParse(conversation)
    if (
      !parsedConversation.success ||
      parsedConversation.data.user1_id !== orderedUser1 ||
      parsedConversation.data.user2_id !== orderedUser2
    ) {
      logger.error('[Start Message API] Invalid conversation acknowledgement:', conversation)
      return NextResponse.json({ error: 'Unable to create conversation' }, { status: 500 })
    }
    const acknowledgedConversation = parsedConversation.data

    // 追踪会话创建/获取
    traceMessage({
      event: 'conversation_created',
      conversationId: acknowledgedConversation.id,
      senderId,
      receiverId,
      metadata: { isMutualFollow },
    })

    return NextResponse.json({
      conversation_id: acknowledgedConversation.id,
      sender_id: senderId,
      receiver_id: receiverId,
      can_message: canMessage,
      is_mutual_follow: isMutualFollow,
      message_limit: messageLimit,
      receiver_handle: receiverProfile?.handle || null,
    })
  },
  { name: 'messages-start', rateLimit: 'write' }
)
