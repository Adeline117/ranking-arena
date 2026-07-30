import {
  DM_REACTION_EMOJIS,
  type MessageReaction,
} from '@/app/(app)/messages/[conversationId]/components/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function readChannelMessageReactionAcknowledgement(
  value: unknown,
  expected: { emoji: string; messageId: string; operationId: string }
): MessageReaction[] | null {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(',') !== 'data,success' ||
    value.success !== true ||
    !isRecord(value.data)
  ) {
    return null
  }

  const data = value.data
  const expectedKeys = [
    'action',
    'counts',
    'emoji',
    'messageId',
    'operationId',
    'replayed',
    'userEmojis',
  ]
  if (
    Object.keys(data).sort().join(',') !== expectedKeys.sort().join(',') ||
    (data.action !== 'added' && data.action !== 'removed') ||
    data.emoji !== expected.emoji ||
    data.messageId !== expected.messageId ||
    data.operationId !== expected.operationId ||
    typeof data.replayed !== 'boolean' ||
    !isRecord(data.counts) ||
    !Array.isArray(data.userEmojis)
  ) {
    return null
  }

  const userEmojis = new Set<string>()
  for (const emoji of data.userEmojis) {
    if (
      typeof emoji !== 'string' ||
      emoji.length === 0 ||
      emoji.length > 32 ||
      userEmojis.has(emoji) ||
      data.counts[emoji] === undefined
    ) {
      return null
    }
    userEmojis.add(emoji)
  }

  if (
    (data.action === 'added' && !userEmojis.has(expected.emoji)) ||
    (data.action === 'removed' && userEmojis.has(expected.emoji))
  ) {
    return null
  }

  const reactions: MessageReaction[] = []
  for (const [emoji, count] of Object.entries(data.counts)) {
    if (
      emoji.length === 0 ||
      emoji.length > 32 ||
      typeof count !== 'number' ||
      !Number.isSafeInteger(count) ||
      count <= 0
    ) {
      return null
    }
    reactions.push({ emoji, count, mine: userEmojis.has(emoji) })
  }

  if (
    !DM_REACTION_EMOJIS.includes(expected.emoji) ||
    (data.action === 'added' && !reactions.some((reaction) => reaction.emoji === expected.emoji))
  ) {
    return null
  }

  return reactions
}
