/**
 * Direct Message Emoji Reactions API
 * POST /api/messages/[messageId]/react - Toggle an emoji reaction on a 1:1 DM
 *
 * Mirrors app/api/posts/[id]/emoji-react/route.ts:
 *   check existing row → delete or insert → re-aggregate → return { counts, userEmojis }
 *
 * SECURITY: caller must be a participant (sender or receiver) of the parent DM.
 */

import { NextResponse } from 'next/server'
import { success } from '@/lib/api'
import { withAuth } from '@/lib/api/middleware'
import type { SupabaseClient } from '@supabase/supabase-js'
import { socialFeatureGuard } from '@/lib/features'
import { sendNotification } from '@/lib/data/notifications'
import { getUserHandle } from '@/lib/supabase/server'
import { fireAndForget } from '@/lib/utils/logger'

// Allowed emoji set — reuse the post reaction allowlist (crypto-relevant, focused)
const ALLOWED_EMOJIS = new Set([
  '👍',
  '🔥',
  '💎',
  '🚀',
  '❤️',
  '👀',
  '🎯',
  '💰',
  '📈',
  '📉',
  '🤔',
  '😂',
])

/** Extract message id from URL path (/api/messages/<messageId>/react) */
function extractMessageId(url: string): string {
  const pathParts = new URL(url).pathname.split('/')
  const idx = pathParts.indexOf('messages')
  return pathParts[idx + 1]
}

export const POST = withAuth(
  async ({ user, supabase, request }) => {
    const guard = socialFeatureGuard()
    if (guard) return guard

    const messageId = extractMessageId(request.url)
    const sb = supabase as SupabaseClient

    let body: Record<string, unknown>
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const emoji = body.emoji as string

    if (!emoji || !ALLOWED_EMOJIS.has(emoji)) {
      return NextResponse.json({ error: 'Invalid emoji' }, { status: 400 })
    }

    // Verify caller is a participant of the parent DM
    const { data: parentMsg, error: msgError } = await sb
      .from('direct_messages')
      .select('id, sender_id, receiver_id, conversation_id, content')
      .eq('id', messageId)
      .is('deleted_at', null)
      .maybeSingle()

    if (msgError || !parentMsg) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 })
    }

    if (parentMsg.sender_id !== user.id && parentMsg.receiver_id !== user.id) {
      return NextResponse.json({ error: 'No permission to react to this message' }, { status: 403 })
    }

    // Check if reaction already exists (toggle)
    const { data: existing } = await sb
      .from('message_reactions')
      .select('id')
      .eq('message_id', messageId)
      .eq('user_id', user.id)
      .eq('emoji', emoji)
      .maybeSingle()

    if (existing) {
      await sb.from('message_reactions').delete().eq('id', existing.id)
    } else {
      await sb.from('message_reactions').insert({
        message_id: messageId,
        user_id: user.id,
        emoji,
      })
    }

    // Re-aggregate counts for this message
    const { data: reactions } = await sb
      .from('message_reactions')
      .select('emoji, user_id')
      .eq('message_id', messageId)

    const counts: Record<string, number> = {}
    const userEmojis: string[] = []
    for (const r of reactions || []) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1
      if (r.user_id === user.id) userEmojis.push(r.emoji)
    }

    // Notify the message author when a reaction is ADDED (skip self-reactions)
    if (!existing && parentMsg.sender_id && parentMsg.sender_id !== user.id) {
      fireAndForget(
        getUserHandle(user.id, user.email ?? undefined).then((handle) => {
          sendNotification(
            supabase,
            {
              user_id: parentMsg.sender_id,
              type: 'reaction',
              title: `${handle} reacted ${emoji} to your message`,
              message: (parentMsg.content || '').slice(0, 100) || 'your message',
              actor_id: user.id,
              link: `/messages/${parentMsg.conversation_id}`,
              reference_id: messageId,
              read: false,
            },
            'DM reaction notification'
          )
        }),
        'DM reaction notification setup'
      )
    }

    return success({
      action: existing ? 'removed' : 'added',
      emoji,
      counts,
      userEmojis,
    })
  },
  { name: 'messages/react-post', rateLimit: 'write' }
)
