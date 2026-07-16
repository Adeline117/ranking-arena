export type OnboardingMembershipAction = 'join' | 'leave'

export type OnboardingMembershipScope = {
  active: boolean
  revision: number
  viewerId: string | null
}

export type OnboardingMembershipIntent = {
  action: OnboardingMembershipAction
  groupId: string
  revision: number
  scopeRevision: number
  viewerId: string
}

type MembershipFetch = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isMemberCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function isMembershipAcknowledgement(action: OnboardingMembershipAction, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const acknowledgement = value as Record<string, unknown>
  if (acknowledgement.success !== true || typeof acknowledgement.action !== 'string') return false

  if (action === 'leave') {
    return (
      (acknowledgement.action === 'left' && isMemberCount(acknowledgement.member_count)) ||
      acknowledgement.action === 'not_member'
    )
  }

  if (acknowledgement.action === 'joined') {
    return isMemberCount(acknowledgement.member_count)
  }

  if (acknowledgement.action === 'already_member') {
    return (
      isMemberCount(acknowledgement.member_count) &&
      (acknowledgement.role === 'owner' ||
        acknowledgement.role === 'admin' ||
        acknowledgement.role === 'member')
    )
  }

  return (
    acknowledgement.action === 'requested' &&
    typeof acknowledgement.request_id === 'string' &&
    UUID_PATTERN.test(acknowledgement.request_id)
  )
}

/** Per-resource revisions prevent an older request from reconciling a newer click. */
export class OnboardingMembershipIntentLedger {
  private readonly revisions = new Map<string, number>()

  issue(
    groupId: string,
    action: OnboardingMembershipAction,
    scope: OnboardingMembershipScope
  ): OnboardingMembershipIntent | null {
    if (!scope.active || !scope.viewerId) return null

    const revision = (this.revisions.get(groupId) ?? 0) + 1
    this.revisions.set(groupId, revision)

    return {
      action,
      groupId,
      revision,
      scopeRevision: scope.revision,
      viewerId: scope.viewerId,
    }
  }

  isCurrent(intent: OnboardingMembershipIntent, scope: OnboardingMembershipScope): boolean {
    return (
      scope.active &&
      scope.viewerId === intent.viewerId &&
      scope.revision === intent.scopeRevision &&
      this.revisions.get(intent.groupId) === intent.revision
    )
  }

  belongsToScope(intent: OnboardingMembershipIntent, scope: OnboardingMembershipScope): boolean {
    return (
      scope.active && scope.viewerId === intent.viewerId && scope.revision === intent.scopeRevision
    )
  }
}

/**
 * Keep requests for one group ordered while allowing unrelated groups to run in
 * parallel. This prevents a slow old join from landing after a newer leave.
 */
export class OnboardingMembershipRequestSequencer {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(groupId) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )

    this.tails.set(groupId, tail)
    void tail.finally(() => {
      if (this.tails.get(groupId) === tail) this.tails.delete(groupId)
    })

    return result
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      const pending = [...this.tails.entries()]
      await Promise.all(pending.map(([, tail]) => tail))
      for (const [groupId, tail] of pending) {
        if (this.tails.get(groupId) === tail) this.tails.delete(groupId)
      }
    }
  }
}

export function rollbackOnboardingMembershipIntent(
  joinedGroups: ReadonlySet<string>,
  intent: OnboardingMembershipIntent
): Set<string> {
  const next = new Set(joinedGroups)
  if (intent.action === 'join') next.delete(intent.groupId)
  else next.add(intent.groupId)
  return next
}

export async function sendOnboardingMembershipIntent(
  intent: OnboardingMembershipIntent,
  accessToken: string,
  csrfHeaders: Record<string, string>,
  fetcher: MembershipFetch = fetch
): Promise<void> {
  const response = await fetcher(`/api/groups/${encodeURIComponent(intent.groupId)}/membership`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...csrfHeaders,
    },
    body: JSON.stringify({ action: intent.action }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || !isMembershipAcknowledgement(intent.action, payload)) {
    throw new Error(`Group membership request failed with status ${response.status}`)
  }
}
