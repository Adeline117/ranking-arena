export function shouldLoadExpandedGroupComments(options: {
  accessToken: string | null
  authChecked: boolean
  audienceResolved: boolean
  groupVisibility: 'open' | 'apply' | null
  isMember: boolean
  expanded: boolean
  hasCachedComments: boolean
  loading: boolean
}): boolean {
  if (!options.authChecked || !options.audienceResolved) return false
  const canRead =
    options.groupVisibility === 'open' ||
    (options.groupVisibility === 'apply' && options.isMember && !!options.accessToken)
  return canRead && options.expanded && !options.hasCachedComments && !options.loading
}
