export type OnboardingFollowAction = 'follow' | 'unfollow'

export type OnboardingFollowScope = {
  active: boolean
  revision: number
  viewerId: string | null
}

export type OnboardingFollowIntent = {
  accountKey: string
  action: OnboardingFollowAction
  revision: number
  scopeRevision: number
  source: string
  traderId: string
  viewerId: string
}

type FollowFetch = (
  input: string,
  init: RequestInit
) => Promise<Pick<Response, 'json' | 'ok' | 'status'>>

function isFollowAcknowledgement(action: OnboardingFollowAction, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false

  const envelope = value as Record<string, unknown>
  const data =
    envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : null
  const expected = action === 'follow'

  return envelope.success === true && data?.following === expected
}

/**
 * A revision per exchange account makes a later click authoritative even when
 * an older request is already in flight.
 */
export class OnboardingFollowIntentLedger {
  private readonly revisions = new Map<string, number>()

  issue(
    account: { accountKey: string; source: string; traderId: string },
    action: OnboardingFollowAction,
    scope: OnboardingFollowScope
  ): OnboardingFollowIntent | null {
    if (
      !scope.active ||
      !scope.viewerId ||
      !account.accountKey ||
      !account.source ||
      !account.traderId
    ) {
      return null
    }

    const revision = (this.revisions.get(account.accountKey) ?? 0) + 1
    this.revisions.set(account.accountKey, revision)

    return {
      ...account,
      action,
      revision,
      scopeRevision: scope.revision,
      viewerId: scope.viewerId,
    }
  }

  isCurrent(intent: OnboardingFollowIntent, scope: OnboardingFollowScope): boolean {
    return (
      this.belongsToScope(intent, scope) &&
      this.revisions.get(intent.accountKey) === intent.revision
    )
  }

  belongsToScope(intent: OnboardingFollowIntent, scope: OnboardingFollowScope): boolean {
    return (
      scope.active && scope.viewerId === intent.viewerId && scope.revision === intent.scopeRevision
    )
  }
}

/** Serialize one exchange account while allowing unrelated accounts to proceed. */
export class OnboardingFollowRequestSequencer {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(accountKey: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(accountKey) ?? Promise.resolve()
    const result = previous.catch(() => undefined).then(operation)
    const tail = result.then(
      () => undefined,
      () => undefined
    )

    this.tails.set(accountKey, tail)
    void tail.finally(() => {
      if (this.tails.get(accountKey) === tail) this.tails.delete(accountKey)
    })

    return result
  }

  async drain(): Promise<void> {
    while (this.tails.size > 0) {
      const pending = [...this.tails.entries()]
      await Promise.all(pending.map(([, tail]) => tail))
      for (const [accountKey, tail] of pending) {
        if (this.tails.get(accountKey) === tail) this.tails.delete(accountKey)
      }
    }
  }
}

export async function sendOnboardingFollowIntent(
  intent: OnboardingFollowIntent,
  accessToken: string,
  csrfHeaders: Record<string, string>,
  fetcher: FollowFetch = fetch
): Promise<void> {
  const response = await fetcher('/api/follow', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...csrfHeaders,
    },
    body: JSON.stringify({
      traderId: intent.traderId,
      source: intent.source,
      action: intent.action,
    }),
  })

  const payload = await response.json().catch(() => null)
  if (!response.ok || !isFollowAcknowledgement(intent.action, payload)) {
    throw new Error(`Trader follow request failed with status ${response.status}`)
  }
}
