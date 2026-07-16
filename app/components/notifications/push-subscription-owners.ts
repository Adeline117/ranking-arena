const PUSH_SUBSCRIPTION_OWNERS_KEY = 'arena:push-subscription-owners:v1'

type StoredPushOwner = {
  endpoint: string
  userIds: string[]
}

function readStoredOwners(storage: Pick<Storage, 'getItem'>): StoredPushOwner[] {
  try {
    const raw = storage.getItem(PUSH_SUBSCRIPTION_OWNERS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value): StoredPushOwner[] => {
      if (!value || typeof value !== 'object') return []
      const candidate = value as Partial<StoredPushOwner>
      if (typeof candidate.endpoint !== 'string' || !Array.isArray(candidate.userIds)) return []
      const userIds = [
        ...new Set(
          candidate.userIds.filter((id): id is string => typeof id === 'string' && id.length > 0)
        ),
      ]
      return candidate.endpoint ? [{ endpoint: candidate.endpoint, userIds }] : []
    })
  } catch {
    return []
  }
}

export function isPushSubscriptionOwnedBy(
  storage: Pick<Storage, 'getItem'>,
  endpoint: string,
  userId: string
): boolean {
  return readStoredOwners(storage).some(
    (entry) => entry.endpoint === endpoint && entry.userIds.includes(userId)
  )
}

/**
 * Records only the local browser's explicit server registrations. A single
 * origin PushSubscription may be shared by several signed-in accounts, so the
 * registry is many-to-many and removing B must preserve A.
 */
export function setPushSubscriptionOwner(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  endpoint: string,
  userId: string,
  owned: boolean
): boolean {
  try {
    const entries = readStoredOwners(storage)
    const existing = entries.find((entry) => entry.endpoint === endpoint)
    const userIds = new Set(existing?.userIds ?? [])
    if (owned) userIds.add(userId)
    else userIds.delete(userId)

    const next = entries.filter((entry) => entry.endpoint !== endpoint)
    if (userIds.size > 0) next.push({ endpoint, userIds: [...userIds] })
    storage.setItem(PUSH_SUBSCRIPTION_OWNERS_KEY, JSON.stringify(next))
    return true
  } catch {
    return false
  }
}
