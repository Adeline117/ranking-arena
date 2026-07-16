/**
 * Chat Channels API
 * GET: List user's channels (direct + group)
 * POST: Create a new group channel
 */

import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { getAuthUser, getSupabaseAdmin } from '@/lib/supabase/server'
import { checkRateLimit, RateLimitPresets } from '@/lib/utils/rate-limit'
import { createLogger } from '@/lib/utils/logger'
import { channelIdSchema, createGroupChannelInputSchema } from './contracts'

const logger = createLogger('api:channels')

const createChannelFailureReasons = new Set([
  'ACTOR_UNAVAILABLE',
  'CANDIDATE_UNAVAILABLE',
  'PRIVACY_DENIED',
  'CHANNEL_ID_CONFLICT',
])

type CreatedGroupChannel = {
  id: string
  name: string
  type: 'group'
  created_by: string
  avatar_url: string | null
  description: string | null
  conversation_id: string | null
  last_message_at: string
  last_message_preview: string | null
  created_at: string
  updated_at: string
}

type CreatedGroupChannelMember = {
  userId: string
  role: 'owner' | 'member'
}

type CreateGroupChannelAcknowledgement =
  | {
      success: true
      channel: CreatedGroupChannel
      memberCount: number
      members: CreatedGroupChannelMember[]
    }
  | { success: false; reason: string }

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

function readCreatedChannel(value: unknown): CreatedGroupChannel | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const channel = value as Record<string, unknown>
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
    !channelIdSchema.safeParse(channel.id).success ||
    !channelIdSchema.safeParse(channel.created_by).success ||
    typeof channel.name !== 'string' ||
    channel.type !== 'group' ||
    (channel.avatar_url !== null && typeof channel.avatar_url !== 'string') ||
    (channel.description !== null && typeof channel.description !== 'string') ||
    channel.conversation_id !== null ||
    !isTimestamp(channel.last_message_at) ||
    (channel.last_message_preview !== null && typeof channel.last_message_preview !== 'string') ||
    !isTimestamp(channel.created_at) ||
    !isTimestamp(channel.updated_at)
  ) {
    return null
  }

  return {
    id: (channel.id as string).toLowerCase(),
    name: channel.name,
    type: 'group',
    created_by: (channel.created_by as string).toLowerCase(),
    avatar_url: channel.avatar_url as string | null,
    description: channel.description as string | null,
    conversation_id: null,
    last_message_at: channel.last_message_at,
    last_message_preview: channel.last_message_preview as string | null,
    created_at: channel.created_at,
    updated_at: channel.updated_at,
  }
}

function readCreateGroupChannelAcknowledgement(
  value: unknown
): CreateGroupChannelAcknowledgement | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null

  const result = value as Record<string, unknown>
  if (result.success === true) {
    if (!hasExactKeys(result, ['channel', 'member_count', 'members', 'success'])) return null
    const channel = readCreatedChannel(result.channel)
    if (
      !channel ||
      !Number.isSafeInteger(result.member_count) ||
      (result.member_count as number) < 2 ||
      (result.member_count as number) > 50 ||
      !Array.isArray(result.members) ||
      result.members.length !== result.member_count
    ) {
      return null
    }

    const members: CreatedGroupChannelMember[] = []
    for (const value of result.members) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      const member = value as Record<string, unknown>
      if (
        !hasExactKeys(member, ['role', 'user_id']) ||
        !channelIdSchema.safeParse(member.user_id).success ||
        (member.role !== 'owner' && member.role !== 'member')
      ) {
        return null
      }
      members.push({ userId: (member.user_id as string).toLowerCase(), role: member.role })
    }
    if (members.some((member, index) => index > 0 && members[index - 1].userId >= member.userId)) {
      return null
    }

    return {
      success: true,
      channel,
      memberCount: result.member_count as number,
      members,
    }
  }

  if (result.success === false) {
    if (!hasExactKeys(result, ['reason', 'success'])) return null
    if (typeof result.reason !== 'string' || !createChannelFailureReasons.has(result.reason)) {
      return null
    }
    return { success: false, reason: result.reason }
  }

  return null
}

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const supabase = getSupabaseAdmin()
    const type = request.nextUrl.searchParams.get('type') // 'group' | 'all'

    // Get channels the user is a member of
    const query = supabase
      .from('channel_members')
      .select(
        `
        channel_id,
        role,
        is_muted,
        is_pinned,
        chat_channels (
          id, name, type, avatar_url, description,
          last_message_at, last_message_preview, created_by
        )
      `
      )
      .eq('user_id', user.id)

    const { data: memberships, error } = await query
    if (error) {
      return NextResponse.json({ error: 'Failed to fetch channels' }, { status: 500 })
    }

    let channels = (memberships || [])
      .filter((m) => m.chat_channels)
      .map((m) => {
        const ch = m.chat_channels as unknown as Record<string, unknown>
        return {
          id: ch.id,
          name: ch.name,
          type: ch.type,
          avatar_url: ch.avatar_url,
          description: ch.description,
          last_message_at: ch.last_message_at,
          last_message_preview: ch.last_message_preview,
          role: m.role,
          is_muted: m.is_muted,
          is_pinned: m.is_pinned,
        }
      })

    if (type === 'group') {
      channels = channels.filter((c) => c.type === 'group')
    }

    // Sort: pinned first, then by last_message_at
    channels.sort((a, b) => {
      if (a.is_pinned && !b.is_pinned) return -1
      if (!a.is_pinned && b.is_pinned) return 1
      return (
        new Date(b.last_message_at as string).getTime() -
        new Date(a.last_message_at as string).getTime()
      )
    })

    return NextResponse.json({ channels })
  } catch (error) {
    logger.error('GET /api/channels failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  const rateLimitResp = await checkRateLimit(request, RateLimitPresets.write)
  if (rateLimitResp) return rateLimitResp

  try {
    const user = await getAuthUser(request)
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
    }
    const parsedBody = createGroupChannelInputSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: 'Invalid group channel request' }, { status: 400 })
    }
    const { channelId: requestedChannelId, name, memberIds, description } = parsedBody.data
    const actorId = user.id.toLowerCase()
    const candidateIds = [...new Set(memberIds)].filter((memberId) => memberId !== actorId)
    if (candidateIds.length === 0) {
      return NextResponse.json({ error: 'Select at least 1 member' }, { status: 400 })
    }
    if (candidateIds.length > 49) {
      return NextResponse.json({ error: 'Group chat max 50 members' }, { status: 400 })
    }

    const channelId = requestedChannelId ?? randomUUID()
    const expectedDescription = description || null
    const { data, error } = await getSupabaseAdmin().rpc('create_group_channel_atomic', {
      p_channel_id: channelId,
      p_actor_id: actorId,
      p_name: name,
      p_description: expectedDescription,
      p_candidate_ids: candidateIds,
    })

    if (error) {
      logger.error('Atomic group channel creation failed', { error: error.message })
      return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
    }

    const acknowledgement = readCreateGroupChannelAcknowledgement(data)
    if (!acknowledgement) {
      logger.error('Atomic group channel creation returned an invalid acknowledgement')
      return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
    }

    if (!acknowledgement.success) {
      switch (acknowledgement.reason) {
        case 'ACTOR_UNAVAILABLE':
          return NextResponse.json({ error: 'Account cannot create a group chat' }, { status: 403 })
        case 'CANDIDATE_UNAVAILABLE':
        case 'PRIVACY_DENIED':
          return NextResponse.json(
            { error: 'One or more selected members cannot be added' },
            { status: 400 }
          )
        case 'CHANNEL_ID_CONFLICT':
          if (requestedChannelId) {
            logger.error('Atomic group channel creation rejected a reused intent id')
            return NextResponse.json({ error: 'Group creation intent changed' }, { status: 409 })
          }
          logger.error('Atomic group channel creation rejected a generated channel id collision')
          return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
        default:
          logger.error('Atomic group channel creation returned an unknown denial')
          return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
      }
    }

    if (
      acknowledgement.channel.id !== channelId ||
      acknowledgement.channel.created_by !== actorId ||
      acknowledgement.channel.name !== name ||
      acknowledgement.channel.description !== expectedDescription ||
      acknowledgement.memberCount !== candidateIds.length + 1
    ) {
      logger.error('Atomic group channel creation acknowledgement did not match its request')
      return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
    }

    const expectedMembers: CreatedGroupChannelMember[] = [
      { userId: actorId, role: 'owner' as const },
      ...candidateIds.map((userId) => ({ userId, role: 'member' as const })),
    ].sort((left, right) => left.userId.localeCompare(right.userId))
    if (
      acknowledgement.members.length !== expectedMembers.length ||
      acknowledgement.members.some(
        (member, index) =>
          member.userId !== expectedMembers[index].userId ||
          member.role !== expectedMembers[index].role
      )
    ) {
      logger.error('Atomic group channel creation acknowledgement returned the wrong roster')
      return NextResponse.json({ error: 'Failed to create group chat' }, { status: 500 })
    }

    return NextResponse.json({ channel: acknowledgement.channel })
  } catch (error) {
    logger.error('POST /api/channels failed', {
      error: error instanceof Error ? error.message : String(error),
    })
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
