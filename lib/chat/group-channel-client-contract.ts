type GroupMemberSearchResult = {
  id: string
  handle: string | null
  avatar_url: string | null
}

type ExpectedGroupChannelCreation = {
  actorId: string
  channelId: string
  description: string | null
  name: string
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function readGroupMemberSearchResults(
  value: unknown,
  expectedActorId: string,
  limit: number
): GroupMemberSearchResult[] | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ['users'])
  ) {
    return null
  }

  const users = (value as { users?: unknown }).users
  if (!Array.isArray(users) || users.length > limit) return null

  const actorId = expectedActorId.toLowerCase()
  const seen = new Set<string>()
  const results: GroupMemberSearchResult[] = []
  for (const candidate of users) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null
    const record = candidate as Record<string, unknown>
    if (
      !hasExactKeys(record, ['avatar_url', 'handle', 'id']) ||
      !isCanonicalUuid(record.id) ||
      record.id === actorId ||
      seen.has(record.id) ||
      (record.handle !== null &&
        (typeof record.handle !== 'string' ||
          record.handle.length < 1 ||
          record.handle.length > 30)) ||
      (record.avatar_url !== null &&
        (typeof record.avatar_url !== 'string' || record.avatar_url.length > 2_048))
    ) {
      return null
    }

    seen.add(record.id)
    results.push({
      id: record.id,
      handle: record.handle as string | null,
      avatar_url: record.avatar_url as string | null,
    })
  }

  return results
}

export function readGroupChannelCreationAcknowledgement(
  value: unknown,
  expected: ExpectedGroupChannelCreation
): { channelId: string } | null {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ['channel'])
  ) {
    return null
  }

  const channel = (value as { channel?: unknown }).channel
  if (!channel || typeof channel !== 'object' || Array.isArray(channel)) return null
  const record = channel as Record<string, unknown>
  if (
    !hasExactKeys(record, [
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
    !isCanonicalUuid(record.id) ||
    record.id !== expected.channelId.toLowerCase() ||
    !isCanonicalUuid(record.created_by) ||
    record.created_by !== expected.actorId.toLowerCase() ||
    record.name !== expected.name ||
    record.type !== 'group' ||
    record.avatar_url !== null ||
    record.description !== expected.description ||
    record.conversation_id !== null ||
    record.last_message_preview !== null ||
    !isTimestamp(record.last_message_at) ||
    !isTimestamp(record.created_at) ||
    !isTimestamp(record.updated_at)
  ) {
    return null
  }

  return { channelId: record.id }
}
