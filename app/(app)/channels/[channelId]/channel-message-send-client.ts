import type { ChannelMessageSendIntent } from './channel-message-send-operation'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export type SentChannelMessage = {
  id: string
  channel_id: string
  sender_id: string
  content: string
  media_url: string | null
  media_type: 'image' | 'video' | 'file' | null
  media_name: string | null
  created_at: string
  reply_to_id: string | null
}

export type ChannelMessageSendAcknowledgement = {
  message: SentChannelMessage
  replayed: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function readMessage(
  value: unknown,
  expected: ChannelMessageSendIntent
): SentChannelMessage | null {
  if (!isRecord(value)) return null
  if (
    !hasExactKeys(value, [
      'channel_id',
      'content',
      'created_at',
      'id',
      'media_name',
      'media_type',
      'media_url',
      'reply_to_id',
      'sender_id',
    ]) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    value.channel_id !== expected.channelId ||
    value.sender_id !== expected.actorId ||
    value.content !== expected.content ||
    value.media_url !== expected.mediaUrl ||
    value.media_type !== expected.mediaType ||
    value.media_name !== expected.mediaName ||
    value.reply_to_id !== expected.replyToId ||
    typeof value.created_at !== 'string' ||
    !Number.isFinite(Date.parse(value.created_at))
  ) {
    return null
  }

  return value as SentChannelMessage
}

export function readChannelMessageSendAcknowledgement(
  value: unknown,
  expected: ChannelMessageSendIntent & { operationId: string }
): ChannelMessageSendAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, ['actorId', 'channelId', 'message', 'operationId', 'replayed']) ||
    value.data.operationId !== expected.operationId ||
    value.data.actorId !== expected.actorId ||
    value.data.channelId !== expected.channelId ||
    typeof value.data.replayed !== 'boolean'
  ) {
    return null
  }

  const message = readMessage(value.data.message, expected)
  return message ? { message, replayed: value.data.replayed } : null
}
