const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export type GroupMemberPreferenceField = 'self_notify_muted' | 'pinned'

export type GroupMemberPreferences = Readonly<{
  viewerId: string
  groupId: string
  selfNotifyMuted: boolean
  pinned: boolean
}>

type ExpectedScope = Readonly<{
  viewerId: string
  groupId: string
}>

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort()
  const canonical = [...expected].sort()
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  )
}

function isCanonicalUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    ISO_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

function readEnvelope(
  value: unknown,
  expectedDataKeys: readonly string[]
): Record<string, unknown> | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['data', 'meta', 'success']) ||
    value.success !== true ||
    !isRecord(value.data) ||
    !hasExactKeys(value.data, expectedDataKeys) ||
    !isRecord(value.meta) ||
    !hasExactKeys(value.meta, ['timestamp']) ||
    !isIsoTimestamp(value.meta.timestamp)
  ) {
    return null
  }
  return value.data
}

function readPreferences(value: unknown, expected: ExpectedScope): GroupMemberPreferences | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['group_id', 'pinned', 'self_notify_muted', 'viewer_id']) ||
    !isCanonicalUuid(value.viewer_id) ||
    !isCanonicalUuid(value.group_id) ||
    value.viewer_id !== expected.viewerId.toLowerCase() ||
    value.group_id !== expected.groupId.toLowerCase() ||
    typeof value.self_notify_muted !== 'boolean' ||
    typeof value.pinned !== 'boolean'
  ) {
    return null
  }

  return {
    viewerId: value.viewer_id,
    groupId: value.group_id,
    selfNotifyMuted: value.self_notify_muted,
    pinned: value.pinned,
  }
}

export function readGroupMemberPreferencesSnapshot(
  value: unknown,
  expected: ExpectedScope
): GroupMemberPreferences | null {
  const data = readEnvelope(value, ['preferences'])
  return data ? readPreferences(data.preferences, expected) : null
}

export function readGroupMemberPreferencesMutationAcknowledgement(
  value: unknown,
  expected: ExpectedScope & {
    field: GroupMemberPreferenceField
    value: boolean
  }
): GroupMemberPreferences | null {
  const data = readEnvelope(value, ['mutation', 'preferences'])
  if (
    !data ||
    !isRecord(data.mutation) ||
    !hasExactKeys(data.mutation, ['field', 'value']) ||
    data.mutation.field !== expected.field ||
    data.mutation.value !== expected.value
  ) {
    return null
  }

  const preferences = readPreferences(data.preferences, expected)
  if (!preferences) return null
  const appliedValue =
    expected.field === 'self_notify_muted' ? preferences.selfNotifyMuted : preferences.pinned
  return appliedValue === expected.value ? preferences : null
}
