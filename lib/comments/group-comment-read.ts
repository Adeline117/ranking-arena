export function shouldLoadExpandedGroupComments(options: {
  accessToken: string | null
  expanded: boolean
  hasCachedComments: boolean
  loading: boolean
}): boolean {
  return !!options.accessToken && options.expanded && !options.hasCachedComments && !options.loading
}
