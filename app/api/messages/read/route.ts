/**
 * Mark messages as read API
 * POST: Mark all messages in a conversation as read for the current user
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function POST(request: NextRequest) {
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

    // Mark all unread messages sent to this user as read
    const { data: updated, error } = await supabase
      .from('direct_messages')
      .update({ read: true, read_at: now })
      .eq('conversation_id', conversationId)
      .eq('receiver_id', user.id)
      .eq('read', false)
      .select('id')

    if (error) {
      return NextResponse.json({ error: 'Failed to mark as read' }, { status: 500 })
    }

    return NextResponse.json({
      ok: true,
      marked_count: updated?.length || 0,
      read_at: now,
    })
  } catch {
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
