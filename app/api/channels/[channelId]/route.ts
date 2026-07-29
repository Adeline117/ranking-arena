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
import { channelIdSchema, updateGroupChannelInputSchema } from '../contracts'

const logger = createLogger('api:channels:channelId')

const dissolveFailureReasons = new Set(['CHANNEL_NOT_GROUP', 'PERMISSION_DENIED'])
const metadataFailureReasons = new Set([
  'INVALID',
  'ACTOR_UNAVAILABLE',
  'CHANNEL_NOT_FOUND',
  'CHANNEL_NOT_GROUP',
  'PERMISSION_DENIED',
])

const metadataFields = ['name', 'avatar_url', 'description'] as const
type MetadataField = (typeof metadataFields)[number]

type UpdatedGroupChannel = {
  id: string
  name: string | null
  type: 'group'
  created_by: string | null
  avatar_url: string | null
  description: string | null
  conversation_id: null
  last_message_at: string | null
  last_message_preview: string | null
  created_at: string | null
  updated_at: string
}

type UpdateGroupChannelAcknowledgement =
  | {
      success: true
      actorId: string
      appliedFields: MetadataField[]
      changed: boolean
      channel: UpdatedGroupChannel
    }
  | { success: false; reason: string }

type DissolveChannelAcknowledgement =
  | { success: true; channelId: string; applied: boolean; deleted: number }
  | { success: false; channelId: string; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readUpdatedGroupChannel(value: unknown): UpdatedGroupChannel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const channel = value as Record<string, unknown>
  const parsedId = channelIdSchema.safeParse(channel.id)
  const parsedCreator =
    channel.created_by === null ? null : channelIdSchema.safeParse(channel.created_by)
  if (
    !hasExactKeys(channel, [
      'avatar_url',
      'conversation_id',
      'created_at',
      'created_by',
      'description',
      'id',
      'last_message_at',
      'last_message_preview',
      'name',
      'type',
      'updated_at',
    ]) ||
    !parsedId.success ||
    (parsedCreator !== null && !parsedCreator.success) ||
    (channel.name !== null && typeof channel.name !== 'string') ||
    channel.type !== 'group' ||
    (channel.avatar_url !== null && typeof channel.avatar_url !== 'string') ||
    (channel.description !== null && typeof channel.description !== 'string') ||
    channel.conversation_id !== null ||
    (channel.last_message_at !== null && !isTimestamp(channel.last_message_at)) ||
    (channel.last_message_preview !== null && typeof channel.last_message_preview !== 'string') ||
    (channel.created_at !== null && !isTimestamp(channel.created_at)) ||
    !isTimestamp(channel.updated_at)
  ) {
    return null
  }

  return {
    id: parsedId.data,
    name: channel.name as string | null,
    type: 'group',
    created_by: parsedCreator === null ? null : parsedCreator.data,
    avatar_url: channel.avatar_url as string | null,
    description: channel.description as string | null,
    conversation_id: null,
    last_message_at: channel.last_message_at as string | null,
    last_message_preview: channel.last_message_preview as string | null,
    created_at: channel.created_at as string | null,
    updated_at: channel.updated_at,
  }
}

function readUpdateGroupChannelAcknowledgement(
  value: unknown
): UpdateGroupChannelAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !metadataFailureReasons.has(result.reason)) {
      return null
    }
    return { success: false, reason: result.reason }
  }

  if (
    result.success !== true ||
    !hasExactKeys(result, ['actor_id', 'applied_fields', 'changed', 'channel', 'success']) ||
    typeof result.changed !== 'boolean' ||
    !Array.isArray(result.applied_fields)
  ) {
    return null
  }

  const parsedActorId = channelIdSchema.safeParse(result.actor_id)
  const channel = readUpdatedGroupChannel(result.channel)
  if (!parsedActorId.success || !channel) return null

  const appliedFields: MetadataField[] = []
  for (const field of result.applied_fields) {
    if (typeof field !== 'string' || !metadataFields.includes(field as MetadataField)) return null
    appliedFields.push(field as MetadataField)
  }
  const canonicalFields = metadataFields.filter((field) => appliedFields.includes(field))
  if (
    appliedFields.length === 0 ||
    appliedFields.length !== canonicalFields.length ||
    appliedFields.some((field, index) => field !== canonicalFields[index])
  ) {
    return null
  }

  return {
    success: true,
    actorId: parsedActorId.data,
    appliedFields,
    changed: result.changed,
    channel,
  }
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

    const parsedChannelId = channelIdSchema.safeParse((await params).channelId)
    if (!parsedChannelId.success) {
      return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = updateGroupChannelInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid channel update' }, { status: 400 })
    }

    const channelId = parsedChannelId.data
    const actorId = user.id.toLowerCase()
    const namePresent = Object.prototype.hasOwnProperty.call(parsedBody.data, 'name')
    const avatarUrlPresent = Object.prototype.hasOwnProperty.call(parsedBody.data, 'avatar_url')
    const descriptionPresent = Object.prototype.hasOwnProperty.call(parsedBody.data, 'description')
    const expectedDescription = descriptionPresent ? parsedBody.data.description || null : null
    const expectedFields = metadataFields.filter(
      (field) =>
        (field === 'name' && namePresent) ||
        (field === 'avatar_url' && avatarUrlPresent) ||
        (field === 'description' && descriptionPresent)
    )

    const { data, error } = await getSupabaseAdmin().rpc('update_group_channel_metadata_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_name: namePresent ? (parsedBody.data.name ?? null) : null,
      p_name_present: namePresent,
      p_avatar_url: avatarUrlPresent ? (parsedBody.data.avatar_url ?? null) : null,
      p_avatar_url_present: avatarUrlPresent,
      p_description: expectedDescription,
      p_description_present: descriptionPresent,
    })

    if (error) {
      logger.error('Atomic group channel metadata update failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
    }

    const acknowledgement = readUpdateGroupChannelAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic group channel metadata update returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'INVALID':
          return NextResponse.json({ error: 'Invalid channel update' }, { status: 400 })
        case 'ACTOR_UNAVAILABLE':
          return NextResponse.json({ error: 'Account cannot update this channel' }, { status: 403 })
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json(
            { error: 'Channel does not support group settings' },
            { status: 400 }
          )
        case 'PERMISSION_DENIED':
          return NextResponse.json({ error: 'Permission denied' }, { status: 403 })
        default:
          logger.error('Atomic group channel metadata update returned an unknown denial')
          return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
      }
    }

    if (
      acknowledgement.actorId !== actorId ||
      acknowledgement.channel.id !== channelId ||
      acknowledgement.appliedFields.length !== expectedFields.length ||
      acknowledgement.appliedFields.some((field, index) => field !== expectedFields[index]) ||
      (namePresent && acknowledgement.channel.name !== parsedBody.data.name) ||
      (avatarUrlPresent && acknowledgement.channel.avatar_url !== parsedBody.data.avatar_url) ||
      (descriptionPresent && acknowledgement.channel.description !== expectedDescription)
    ) {
      logger.error('Atomic group channel metadata acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to update channel' }, { status: 500 })
    }

    return NextResponse.json({ channel: acknowledgement.channel })
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
