type ChannelMemberDeleteAction = 'left' | 'removed'

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  )
}

export function readChannelMemberDeleteAcknowledgement(
  value: unknown,
  expectedAction: ChannelMemberDeleteAction
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const acknowledgement = value as Record<string, unknown>
  return (
    hasExactKeys(acknowledgement, ['action', 'ok']) &&
    acknowledgement.ok === true &&
    acknowledgement.action === expectedAction
  )
}

export function readChannelMemberRoleAcknowledgement(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const acknowledgement = value as Record<string, unknown>
  return hasExactKeys(acknowledgement, ['ok']) && acknowledgement.ok === true
}
