export type FollowIdentityItem = {
  id: string
  identity_key?: string
  type: 'trader' | 'user'
  source?: string | null
  platform?: string
  handle: string
}

/** Stable UI identity for loading state, React keys, and optimistic mutations. */
export function followItemIdentity(item: FollowIdentityItem): string {
  if (item.identity_key) return item.identity_key
  if (item.type === 'user') return `user:${item.id}`
  return item.source == null
    ? `trader:legacy-null:${item.id}`
    : `trader:source:${item.source}:${item.id}`
}

export function removeFollowItemByIdentity<T extends FollowIdentityItem>(
  items: T[],
  target: FollowIdentityItem
): T[] {
  const targetIdentity = followItemIdentity(target)
  return items.filter((item) => followItemIdentity(item) !== targetIdentity)
}

export function followItemHref(item: FollowIdentityItem): string | null {
  if (item.type === 'user') return `/u/${encodeURIComponent(item.handle)}`
  if (!item.platform) return null
  return `/trader/${encodeURIComponent(item.handle)}?platform=${encodeURIComponent(item.platform)}`
}
