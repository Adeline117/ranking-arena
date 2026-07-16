export type MembershipAck =
  | { action: 'joined'; member_count: number }
  | {
      action: 'already_member'
      member_count?: number
      role?: 'owner' | 'admin' | 'member'
    }
  | { action: 'requested'; request_id: string; already_pending?: boolean }

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isMemberCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

export function buildJoinMembershipBody(inviteToken?: string) {
  return {
    action: 'join' as const,
    ...(inviteToken ? { invite_token: inviteToken } : {}),
  }
}

/** Parse only the three success acknowledgements the page knows how to apply. */
export function parseMembershipAck(value: unknown): MembershipAck | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const ack = value as Record<string, unknown>
  if (ack.success !== true || typeof ack.action !== 'string') return null

  if (ack.action === 'joined') {
    return isMemberCount(ack.member_count)
      ? { action: 'joined', member_count: ack.member_count }
      : null
  }

  if (ack.action === 'already_member') {
    if (ack.member_count !== undefined && !isMemberCount(ack.member_count)) return null
    if (
      ack.role !== undefined &&
      ack.role !== 'owner' &&
      ack.role !== 'admin' &&
      ack.role !== 'member'
    ) {
      return null
    }
    return {
      action: 'already_member',
      ...(ack.member_count !== undefined ? { member_count: ack.member_count as number } : {}),
      ...(ack.role !== undefined ? { role: ack.role as 'owner' | 'admin' | 'member' } : {}),
    }
  }

  if (ack.action === 'requested') {
    if (typeof ack.request_id !== 'string' || !UUID_PATTERN.test(ack.request_id)) return null
    if (ack.already_pending !== undefined && typeof ack.already_pending !== 'boolean') return null
    return {
      action: 'requested',
      request_id: ack.request_id,
      ...(ack.already_pending !== undefined ? { already_pending: ack.already_pending } : {}),
    }
  }

  return null
}
