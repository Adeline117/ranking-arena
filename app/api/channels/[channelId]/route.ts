/**
 * Channel detail API
 * GET: Get channel info + members + messages
 * PATCH: Update channel settings (name, avatar, description)
 * DELETE: Dissolve channel (owner only)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { channelIdSchema } from '../contracts'

const logger = createLogger('api:channels:channelId')

const dissolveFailureReasons = new Set(['CHANNEL_NOT_GROUP', 'PERMISSION_DENIED'])

type DissolveChannelAcknowledgement =
  | { success: true; channelId: string; applied: boolean; deleted: number }
  | { success: false; channelId: string; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readDissolveChannelAcknowledgement(value: unknown): DissolveChannelAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === true) {
    if (!hasExactKeys(result, ['applied', 'channel_id', 'deleted', 'success'])) return null
    const parsedChannelId = channelIdSchema.safeParse(result.channel_id)
    if (
      !parsedChannelId.success ||
      typeof result.applied !== 'boolean' ||
      !Number.isSafeInteger(result.deleted) ||
      (result.applied && result.deleted !== 1) ||
      (!result.applied && result.deleted !== 0)
    ) {
      return null
    }
    return {
      success: true,
      channelId: parsedChannelId.data,
      applied: result.applied,
      deleted: result.deleted as number,
    }
  }

  if (result.success === false) {
    if (!hasExactKeys(result, ['channel_id', 'reason', 'success'])) return null
    const parsedChannelId = channelIdSchema.safeParse(result.channel_id)
    if (
      !parsedChannelId.success ||
      typeof result.reason !== 'string' ||
      !dissolveFailureReasons.has(result.reason)
    ) {
      return null
    }
    return { success: false, channelId: parsedChannelId.data, reason: result.reason }
  }

  return null
}

export const dynamic = 'force-dynamic'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { channelId } = await params
    // Cast: channel_message_reactions + channel_messages.reply_to_id are not yet in
    // the generated DB types (new migration). Mirrors the messages route pattern.
    const supabase = getSupabaseAdmin() as SupabaseClient

    // Verify membership
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership) {
      return NextResponse.json({ error: 'Not a member' }, { status: 403 })
    }

    // Get channel info
    const { data: channel } = await supabase
      .from('chat_channels')
      .select('id, name, avatar_url, description, type, created_by, created_at, updated_at')
      .eq('id', channelId)
      .single()

    // Get members with profiles
    const { data: members } = await supabase
      .from('channel_members')
      .select('user_id, role, nickname, joined_at')
      .eq('channel_id', channelId)

    // Get member profiles
    const memberIds = members?.map((m) => m.user_id) || []
    const { data: profiles } = await supabase
      .from('user_profiles')
      .select('id, handle, avatar_url')
      .in('id', memberIds)

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]))

    const membersWithProfiles = (members || []).map((m) => ({
      ...m,
      handle: profileMap.get(m.user_id)?.handle || null,
      avatar_url: profileMap.get(m.user_id)?.avatar_url || null,
    }))

    // Get messages (latest 50)
    const before = request.nextUrl.searchParams.get('before')
    let msgQuery = supabase
      .from('channel_messages')
      .select('id, sender_id, content, media_url, media_type, media_name, created_at, reply_to_id')
      .eq('channel_id', channelId)
      .order('created_at', { ascending: false })
      .limit(51)

    if (before) {
      msgQuery = msgQuery.lt('created_at', before)
    }

    const { data: messages } = await msgQuery
    const hasMore = (messages?.length || 0) > 50
    const baseMessages = (messages || []).slice(0, 50).reverse()

    // Enrich with reply previews (parent snippet) + emoji reactions — batched (no N+1)
    const replyIds = Array.from(
      new Set(baseMessages.map((m) => m.reply_to_id).filter(Boolean))
    ) as string[]
    const replyPreviewMap = new Map<string, { sender_id: string; content: string }>()
    if (replyIds.length > 0) {
      const { data: parents } = await supabase
        .from('channel_messages')
        .select('id, sender_id, content')
        .in('id', replyIds)
      for (const p of parents || []) {
        replyPreviewMap.set(p.id, {
          sender_id: p.sender_id,
          content: (p.content || '').slice(0, 120),
        })
      }
    }

    const messageIds = baseMessages.map((m) => m.id)
    const reactionMap = new Map<string, Record<string, { count: number; mine: boolean }>>()
    if (messageIds.length > 0) {
      const { data: reactionRows } = await supabase
        .from('channel_message_reactions')
        .select('message_id, emoji, user_id')
        .in('message_id', messageIds)
      for (const r of reactionRows || []) {
        let byEmoji = reactionMap.get(r.message_id)
        if (!byEmoji) {
          byEmoji = {}
          reactionMap.set(r.message_id, byEmoji)
        }
        const entry = byEmoji[r.emoji] || { count: 0, mine: false }
        entry.count += 1
        if (r.user_id === user.id) entry.mine = true
        byEmoji[r.emoji] = entry
      }
    }

    const resultMessages = baseMessages.map((m) => ({
      ...m,
      reply_preview: m.reply_to_id ? replyPreviewMap.get(m.reply_to_id) || null : null,
      reactions: (() => {
        const byEmoji = reactionMap.get(m.id)
        if (!byEmoji) return []
        return Object.entries(byEmoji).map(([emoji, v]) => ({
          emoji,
          count: v.count,
          mine: v.mine,
        }))
      })(),
    }))

    // Update read status
    await supabase.from('channel_message_reads').upsert({
      channel_id: channelId,
      user_id: user.id,
      last_read_at: new Date().toISOString(),
    })

    return NextResponse.json({
      channel,
      members: membersWithProfiles,
      messages: resultMessages,
      has_more: hasMore,
      my_role: membership.role,
    })
  } catch (error) {
    logger.error('GET_CHANNEL failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { channelId } = await params
    const supabase = getSupabaseAdmin()

    // Check admin/owner role
    const { data: membership } = await supabase
      .from('channel_members')
      .select('role')
      .eq('channel_id', channelId)
      .eq('user_id', user.id)
      .maybeSingle()

    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
    }

    const body = await request.json()
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }

    if (body.name !== undefined) updates.name = body.name.trim()
    if (body.avatar_url !== undefined) updates.avatar_url = body.avatar_url
    if (body.description !== undefined) updates.description = body.description?.trim() || null

    const { data: channel, error } = await supabase
      .from('chat_channels')
      .update(updates)
      .eq('id', channelId)
      .select()
      .single()

    if (error) return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })

    return NextResponse.json({ channel })
  } catch (error) {
    logger.error('PATCH_CHANNEL failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ channelId: string }> }
) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const parsedChannelId = channelIdSchema.safeParse((await params).channelId)
    if (!parsedChannelId.success) {
      return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
    }
    const channelId = parsedChannelId.data
    const actorId = user.id.toLowerCase()

    const { data, error } = await getSupabaseAdmin().rpc('dissolve_group_channel_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
    })

    if (error) {
      logger.error('Atomic group channel dissolution failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to dissolve channel' }, { status: 500 })
    }

    const acknowledgement = readDissolveChannelAcknowledgement(data)
    if (!acknowledgement || acknowledgement.channelId !== channelId) {
      logger.error('Atomic group channel dissolution returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to dissolve channel' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      if (acknowledgement.reason === 'PERMISSION_DENIED') {
        return NextResponse.json({ error: 'Only owner can dissolve' }, { status: 403 })
      }
      if (acknowledgement.reason === 'CHANNEL_NOT_GROUP') {
        return NextResponse.json({ error: 'Channel cannot be dissolved' }, { status: 400 })
      }
      logger.error('Atomic group channel dissolution returned an unknown denial')
      return NextResponse.json({ error: 'Failed to dissolve channel' }, { status: 500 })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    logger.error('DELETE_CHANNEL failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
