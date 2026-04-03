/**
 * Mark messages as read API
 * POST: Mark all messages in a conversation as read for the current user
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { socialFeatureGuard } from '@/lib/features'

const logger = createLogger('api:messages-read')

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
  const guard = socialFeatureGuard()
  if (guard) return guard

  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { conversationId } = await request.json()
    if (!conversationId) {
      return NextResponse.json({ error: 'Missing conversationId' }, { status: 400 })
    }

    const supabase = getSupabaseAdmin()

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
      return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      marked_count: updated?.length || 0,
      read_at: now,
    })
  } catch (error) {
    logger.error('POST failed', { error: error instanceof Error ? error.message : String(error) })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
