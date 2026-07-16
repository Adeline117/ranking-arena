export type PostReaction = 'up' | 'down'

export type PostReactionAction = 'added' | 'removed' | 'changed'

export type PostReactionAcknowledgement = {
  action: PostReactionAction
  reaction: PostReaction | null
  like_count: number | null
  dislike_count: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (Number.isSafeInteger(value) && (value as number) >= 0)
}

/**
 * Parse the complete reaction API envelope before a client adopts its state.
 * Count reads can legitimately fail after the reaction commits, in which case
 * the API returns null and callers must preserve their last known counts.
 */
export function parsePostReactionAcknowledgement(
  value: unknown,
  requestedReaction: PostReaction
): PostReactionAcknowledgement | null {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return null

  const acknowledgement = value.data
  const { action, reaction, like_count: likeCount, dislike_count: dislikeCount } = acknowledgement

  if (action !== 'added' && action !== 'removed' && action !== 'changed') return null
  if (!Object.hasOwn(acknowledgement, 'like_count') || !isNullableCount(likeCount)) return null
  if (!Object.hasOwn(acknowledgement, 'dislike_count') || !isNullableCount(dislikeCount))
    return null

  if (action === 'removed') {
    if (reaction !== null) return null
  } else if (reaction !== requestedReaction) {
    return null
  }

  return {
    action,
    reaction: reaction as PostReaction | null,
    like_count: likeCount,
    dislike_count: dislikeCount,
  }
}
