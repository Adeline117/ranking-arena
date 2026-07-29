/**
 * Channel detail API
 * GET: Get channel info + members + messages
 * PATCH: Update channel settings (name, avatar, description)
 * DELETE: Dissolve channel (owner only)
 */

import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { z } from 'zod'
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

const groupChannelPageFailureSchema = z
  .object({
    success: z.literal(false),
    reason: z.enum([
      'INVALID',
      'ACTOR_UNAVAILABLE',
      'CHANNEL_NOT_FOUND',
      'CHANNEL_NOT_GROUP',
      'MEMBERSHIP_NOT_FOUND',
    ]),
  })
  .strict()

const timestampSchema = z.string().datetime({ offset: true })
const nullableTimestampSchema = timestampSchema.nullable()
const groupChannelPageSchema = z
  .object({
    success: z.literal(true),
    actor_id: channelIdSchema,
    channel_id: channelIdSchema,
    channel: z
      .object({
        id: channelIdSchema,
        name: z.string().nullable(),
        avatar_url: z.string().nullable(),
        description: z.string().nullable(),
        type: z.literal('group'),
        created_by: channelIdSchema.nullable(),
        created_at: nullableTimestampSchema,
        updated_at: nullableTimestampSchema,
      })
      .strict(),
    members: z.array(
      z
        .object({
          user_id: channelIdSchema,
          role: z.enum(['owner', 'admin', 'member']),
          nickname: z.string().nullable(),
          joined_at: nullableTimestampSchema,
          handle: z.string().nullable(),
          avatar_url: z.string().nullable(),
        })
        .strict()
    ),
    messages: z
      .array(
        z
          .object({
            id: channelIdSchema,
            sender_id: channelIdSchema,
            content: z.string(),
            media_url: z.string().nullable(),
            media_type: z.enum(['image', 'video', 'file']).nullable(),
            media_name: z.string().nullable(),
            created_at: nullableTimestampSchema,
            reply_to_id: channelIdSchema.nullable(),
            reply_preview: z
              .object({ sender_id: channelIdSchema, content: z.string().max(120) })
              .strict()
              .nullable(),
            reactions: z.array(
              z
                .object({
                  emoji: z.string().min(1).max(10),
                  count: z.number().int().positive(),
                  mine: z.boolean(),
                })
                .strict()
            ),
          })
          .strict()
      )
      .max(50),
    has_more: z.boolean(),
    my_role: z.enum(['owner', 'admin', 'member']),
    read_at: timestampSchema,
  })
  .strict()

type GroupChannelPageAcknowledgement =
  | z.infer<typeof groupChannelPageFailureSchema>
  | z.infer<typeof groupChannelPageSchema>

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

function readGroupChannelPageAcknowledgement(
  value: unknown
): GroupChannelPageAcknowledgement | null {
  const failure = groupChannelPageFailureSchema.safeParse(value)
  if (failure.success) return failure.data

  const success = groupChannelPageSchema.safeParse(value)
  if (!success.success) return null

  const acknowledgement = success.data
  const memberIds = acknowledgement.members.map((member) => member.user_id)
  if (new Set(memberIds).size !== memberIds.length) return null

  const actorMemberships = acknowledgement.members.filter(
    (member) => member.user_id === acknowledgement.actor_id
  )
  if (
    actorMemberships.length !== 1 ||
    actorMemberships[0]?.role !== acknowledgement.my_role ||
    (acknowledgement.has_more && acknowledgement.messages.length !== 50)
  ) {
    return null
  }

  const messageIds = acknowledgement.messages.map((message) => message.id)
  if (new Set(messageIds).size !== messageIds.length) return null

  for (let index = 0; index < acknowledgement.messages.length; index += 1) {
    const message = acknowledgement.messages[index]
    if (!message) return null

    const emojis = message.reactions.map((reaction) => reaction.emoji)
    if (new Set(emojis).size !== emojis.length) return null

    const previous = acknowledgement.messages[index - 1]
    if (!previous) continue
    if (previous.created_at === null && message.created_at !== null) return null
    if (previous.created_at !== null && message.created_at !== null) {
      const previousTime = Date.parse(previous.created_at)
      const messageTime = Date.parse(message.created_at)
      if (
        previousTime > messageTime ||
        (previousTime === messageTime && previous.id > message.id)
      ) {
        return null
      }
    }
  }

  return acknowledgement
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

    const parsedChannelId = channelIdSchema.safeParse((await params).channelId)
    if (!parsedChannelId.success) {
      return NextResponse.json({ error: 'Invalid channel id' }, { status: 400 })
    }

    const before = request.nextUrl.searchParams.get('before')
    if (before !== null && !timestampSchema.safeParse(before).success) {
      return NextResponse.json({ error: 'Invalid message cursor' }, { status: 400 })
    }

    const channelId = parsedChannelId.data
    const actorId = user.id.toLowerCase()
    const { data, error } = await getSupabaseAdmin().rpc('get_group_channel_page_atomic', {
      p_actor_id: actorId,
      p_channel_id: channelId,
      p_before: before,
      p_limit: 50,
    })

    if (error) {
      logger.error('Atomic group channel page read failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    }

    const acknowledgement = readGroupChannelPageAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic group channel page read returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'INVALID':
          return NextResponse.json({ error: 'Invalid channel request' }, { status: 400 })
        case 'ACTOR_UNAVAILABLE':
          return NextResponse.json({ error: 'Account cannot access this channel' }, { status: 403 })
        case 'CHANNEL_NOT_FOUND':
          return NextResponse.json({ error: 'Channel not found' }, { status: 404 })
        case 'CHANNEL_NOT_GROUP':
          return NextResponse.json({ error: 'Channel is not a group' }, { status: 400 })
        case 'MEMBERSHIP_NOT_FOUND':
          return NextResponse.json({ error: 'Not a member' }, { status: 403 })
        default:
          logger.error('Atomic group channel page read returned an unknown denial')
          return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
      }
    }

    if (
      acknowledgement.actor_id !== actorId ||
      acknowledgement.channel_id !== channelId ||
      acknowledgement.channel.id !== channelId ||
      (before !== null &&
        acknowledgement.messages.some(
          (message) =>
            message.created_at === null || Date.parse(message.created_at) >= Date.parse(before)
        ))
    ) {
      logger.error('Atomic group channel page acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to load channel' }, { status: 500 })
    }

    return NextResponse.json({
      channel: acknowledgement.channel,
      members: acknowledgement.members,
      messages: acknowledgement.messages,
      has_more: acknowledgement.has_more,
      my_role: acknowledgement.my_role,
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
