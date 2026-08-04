type JsonRecord = Record<string, unknown>

export type GroupCommentDeleteAcknowledgement = {
  affectedCount: number
  commentCount: number
}

export type GroupMemberRole = 'admin' | 'member'

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
