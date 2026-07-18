export function buildGroupReturnPath(groupId: string, inviteToken?: string): string {
  const normalizedGroupId = groupId.trim()
  const groupPath = normalizedGroupId
    ? `/groups/${encodeURIComponent(normalizedGroupId)}`
    : '/groups'
  const normalizedInvite = inviteToken?.trim()

  return normalizedInvite
    ? `${groupPath}?invite=${encodeURIComponent(normalizedInvite)}`
    : groupPath
}

export function buildGroupLoginHref(groupId: string, inviteToken?: string): string {
  return `/login?returnUrl=${encodeURIComponent(buildGroupReturnPath(groupId, inviteToken))}`
}
