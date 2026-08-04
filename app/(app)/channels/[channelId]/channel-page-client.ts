import type {
  MessageReaction,
  ReplyPreview,
} from '@/app/(app)/messages/[conversationId]/components/types'
import type { ChannelMessageSendIntent } from './channel-message-send-operation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

export type ChannelMessage = {
  id: string
  channel_id: string
  sender_id: string
  content: string
  media_url?: string | null
  media_type?: 'image' | 'video' | 'file' | null
  media_name?: string | null
  created_at: string
  reply_to_id?: string | null
  reply_preview?: ReplyPreview | null
  reactions?: MessageReaction[]
  _status?: 'sending' | 'sent' | 'failed'
  _tempId?: string
  _sendIntent?: ChannelMessageSendIntent
}

export type ChannelMember = {
  user_id: string
  role: 'owner' | 'admin' | 'member'
  nickname: string | null
  handle: string | null
  avatar_url: string | null
  joined_at: string | null
}

export type GroupChannel = {
  id: string
  name: string | null
  type: 'group'
  avatar_url: string | null
  description: string | null
  created_by: string | null
}

export type ChannelPageSnapshot = {
  channel: GroupChannel
  members: ChannelMember[]
  messages: ChannelMessage[]
  hasMore: boolean
  myRole: 'owner' | 'admin' | 'member'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function isNullableTimestamp(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === 'string' &&
      TIMESTAMP_PATTERN.test(value) &&
      Number.isFinite(Date.parse(value)))
  )
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function parseChannel(value: unknown, expectedChannelId: string): GroupChannel | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, [
      'avatar_url',
      'created_at',
      'created_by',
      'description',
      'id',
      'name',
      'type',
      'updated_at',
    ]) ||
    !isUuid(value.id) ||
    value.id.toLowerCase() !== expectedChannelId ||
    value.type !== 'group' ||
    !isNullableString(value.name) ||
    !isNullableString(value.avatar_url) ||
    !isNullableString(value.description) ||
    (value.created_by !== null && !isUuid(value.created_by)) ||
    !isNullableTimestamp(value.created_at) ||
    !isNullableTimestamp(value.updated_at)
  ) {
    return null
  }
  return {
    id: value.id.toLowerCase(),
    name: value.name,
    type: 'group',
    avatar_url: value.avatar_url,
    description: value.description,
    created_by: value.created_by === null ? null : value.created_by.toLowerCase(),
  }
}

function parseMember(value: unknown): ChannelMember | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, ['avatar_url', 'handle', 'joined_at', 'nickname', 'role', 'user_id']) ||
    !isUuid(value.user_id) ||
    !['owner', 'admin', 'member'].includes(value.role as string) ||
    !isNullableString(value.nickname) ||
    !isNullableString(value.handle) ||
    !isNullableString(value.avatar_url) ||
    !isNullableTimestamp(value.joined_at)
  ) {
    return null
  }
  return {
    user_id: value.user_id.toLowerCase(),
    role: value.role as ChannelMember['role'],
    nickname: value.nickname,
    handle: value.handle,
    avatar_url: value.avatar_url,
    joined_at: value.joined_at,
  }
}

function parseReaction(value: unknown): MessageReaction | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, ['count', 'emoji', 'mine']) ||
    typeof value.emoji !== 'string' ||
    !value.emoji ||
    Array.from(value.emoji).length > 10 ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) <= 0 ||
    typeof value.mine !== 'boolean'
  ) {
    return null
  }
  return { emoji: value.emoji, count: value.count as number, mine: value.mine }
}

function parseReplyPreview(value: unknown): ReplyPreview | null | undefined {
  if (value === null) return null
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['content', 'sender_id']) ||
    !isUuid(value.sender_id) ||
    typeof value.content !== 'string' ||
    value.content.length > 120
  ) {
    return undefined
  }
  return { sender_id: value.sender_id.toLowerCase(), content: value.content }
}

function parseMessage(value: unknown, channelId: string): ChannelMessage | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, [
      'content',
      'created_at',
      'id',
      'media_name',
      'media_type',
      'media_url',
      'reactions',
      'reply_preview',
      'reply_to_id',
      'sender_id',
    ]) ||
    !isUuid(value.id) ||
    !isUuid(value.sender_id) ||
    typeof value.content !== 'string' ||
    !isNullableString(value.media_url) ||
    ![null, 'image', 'video', 'file'].includes(value.media_type as string | null) ||
    !isNullableString(value.media_name) ||
    !isNullableTimestamp(value.created_at) ||
    value.created_at === null ||
    (value.reply_to_id !== null && !isUuid(value.reply_to_id)) ||
    !Array.isArray(value.reactions)
  ) {
    return null
  }
  const replyPreview = parseReplyPreview(value.reply_preview)
  if (replyPreview === undefined) return null
  const reactions = value.reactions.map(parseReaction)
  if (reactions.some((reaction) => reaction === null)) return null
  const typedReactions = reactions as MessageReaction[]
  if (new Set(typedReactions.map((reaction) => reaction.emoji)).size !== typedReactions.length) {
    return null
  }
  return {
    id: value.id.toLowerCase(),
    channel_id: channelId,
    sender_id: value.sender_id.toLowerCase(),
    content: value.content,
    media_url: value.media_url,
    media_type: value.media_type as ChannelMessage['media_type'],
    media_name: value.media_name,
    created_at: value.created_at,
    reply_to_id: value.reply_to_id === null ? null : value.reply_to_id.toLowerCase(),
    reply_preview: replyPreview,
    reactions: typedReactions,
  }
}

export function readChannelPageSnapshot(
  value: unknown,
  expected: { actorId: string; channelId: string }
): ChannelPageSnapshot | null {
  const actorId = expected.actorId.toLowerCase()
  const channelId = expected.channelId.toLowerCase()
  if (!UUID_PATTERN.test(actorId) || !UUID_PATTERN.test(channelId) || !isRecord(value)) return null
  if (!hasExactKeys(value, ['channel', 'has_more', 'members', 'messages', 'my_role'])) return null

  const channel = parseChannel(value.channel, channelId)
  if (
    !channel ||
    !Array.isArray(value.members) ||
    !Array.isArray(value.messages) ||
    typeof value.has_more !== 'boolean' ||
    !['owner', 'admin', 'member'].includes(value.my_role as string)
  ) {
    return null
  }
  const members = value.members.map(parseMember)
  const messages = value.messages.map((message) => parseMessage(message, channelId))
  if (members.some((member) => member === null) || messages.some((message) => message === null)) {
    return null
  }
  const typedMembers = members as ChannelMember[]
  const typedMessages = messages as ChannelMessage[]
  if (
    new Set(typedMembers.map((member) => member.user_id)).size !== typedMembers.length ||
    new Set(typedMessages.map((message) => message.id)).size !== typedMessages.length ||
    typedMembers.filter((member) => member.user_id === actorId && member.role === value.my_role)
      .length !== 1 ||
    (value.has_more && typedMessages.length !== 50)
  ) {
    return null
  }
  return {
    channel,
    members: typedMembers,
    messages: typedMessages,
    hasMore: value.has_more,
    myRole: value.my_role as ChannelPageSnapshot['myRole'],
  }
}
