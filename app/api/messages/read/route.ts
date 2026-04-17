/**
 * Mark messages as read API
 * POST: Mark all messages in a conversation as read for the current user
 */

import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/api/middleware'
import { createLogger } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

const logger = createLogger('api:messages-read')

export const dynamic = 'force-dynamic'

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }

    const { conversationId } = body as { conversationId?: string }
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversationId' }, { status: 400 })
    }

    // Verify user is in this conversation
    const { data: conv } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .or(`user1_id.eq.${user.id},user2_id.eq.${user.id}`)
      .maybeSingle()

    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const now = new Date().toISOString()

    // Mark all unread messages sent to this user as read (exclude soft-deleted)
    const { data: updated, error } = await supabase
      .from('direct_messages')
      .update({ read: true, read_at: now })
      .eq('conversation_id', conversationId)
      .eq('receiver_id', user.id)
      .eq('read', false)
      .is('deleted_at', null)
      .select('id')

    if (error) {
      logger.error('Mark read failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      marked_count: updated?.length || 0,
      read_at: now,
    })
  },
  { name: 'messages-read', rateLimit: 'write' }
)
