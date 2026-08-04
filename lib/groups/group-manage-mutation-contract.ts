type JsonRecord = Record<string, unknown>

export type GroupCommentDeleteAcknowledgement = {
  affectedCount: number
  commentCount: number
}

export type GroupMemberRole = 'admin' | 'member'

export type GroupDissolveAcknowledgement = {
  action: 'dissolved' | 'already_dissolved'
  dissolvedAt: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(value: JsonRecord, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

function isOffsetTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  )
}

/** Accept only the complete acknowledgement emitted by group comment deletion. */
export function readGroupCommentDeleteAcknowledgement(
  value: unknown
): GroupCommentDeleteAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['affected_count', 'comment_count', 'success']) ||
    value.success !== true ||
    !isNonNegativeSafeInteger(value.affected_count) ||
    !isNonNegativeSafeInteger(value.comment_count)
  ) {
    return null
  }

  return {
    affectedCount: value.affected_count,
    commentCount: value.comment_count,
  }
}

/** Accept only the role acknowledgement for the exact role that was requested. */
export function readGroupMemberRoleAcknowledgement(
  value: unknown,
  expectedRole: GroupMemberRole
): GroupMemberRole | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['role', 'success']) ||
    value.success !== true ||
    value.role !== expectedRole
  ) {
    return null
  }

  return expectedRole
}

/** Accept only the exact acknowledgement emitted after a committed member kick. */
export function readGroupMemberKickAcknowledgement(value: unknown): boolean {
  return isRecord(value) && hasExactKeys(value, ['success']) && value.success === true
}

/** Accept both canonical one-way dissolution outcomes and no other 2xx shape. */
export function readGroupDissolveAcknowledgement(
  value: unknown
): GroupDissolveAcknowledgement | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['action', 'dissolved_at', 'success']) ||
    value.success !== true ||
    (value.action !== 'dissolved' && value.action !== 'already_dissolved') ||
    !isOffsetTimestamp(value.dissolved_at)
  ) {
    return null
  }

  return { action: value.action, dissolvedAt: value.dissolved_at }
}
