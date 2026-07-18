import {
  OnboardingFollowIntentLedger,
  OnboardingFollowRequestSequencer,
  sendOnboardingFollowIntent,
  type OnboardingFollowIntent,
  type OnboardingFollowScope,
} from '../follow-intent'

const VIEWER_ID = '10000000-0000-4000-8000-000000000001'

function activeScope(revision = 1): OnboardingFollowScope {
  return { active: true, revision, viewerId: VIEWER_ID }
}

function issueIntent(
  action: 'follow' | 'unfollow' = 'follow',
  accountKey = 'bybit:trader-1',
  scope = activeScope()
): OnboardingFollowIntent {
  const [source, traderId] = accountKey.split(':')
  const intent = new OnboardingFollowIntentLedger().issue(
    { accountKey, source, traderId },
    action,
    scope
  )
  if (!intent) throw new Error('Expected an intent')
  return intent
}

function response(payload: unknown, status = 200) {
  return {
    json: jest.fn().mockResolvedValue(payload),
    ok: status >= 200 && status < 300,
    status,
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('onboarding follow transport contract', () => {
  it.each([
    ['follow', true],
    ['unfollow', false],
  ] as const)(
    'accepts only the canonical wrapped %s acknowledgement',
    async (action, following) => {
      const fetcher = jest.fn().mockResolvedValue(
        response({
          success: true,
          data: { following },
        })
      )
      const intent = issueIntent(action)

      await sendOnboardingFollowIntent(intent, 'access-token', { 'x-csrf-token': 'csrf' }, fetcher)

      expect(fetcher).toHaveBeenCalledWith('/api/follow', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer access-token',
          'x-csrf-token': 'csrf',
        },
        body: JSON.stringify({
          traderId: intent.traderId,
          source: intent.source,
          action,
        }),
      })
    }
  )

  it.each([
    [{ success: true, data: { following: false } }, 200],
    [{ following: true }, 200],
    [{ success: true, data: { following: true } }, 503],
  ])(
    'fails closed on a rejected or contradictory follow acknowledgement',
    async (payload, status) => {
      const fetcher = jest.fn().mockResolvedValue(response(payload, status))

      await expect(
        sendOnboardingFollowIntent(issueIntent('follow'), 'access-token', {}, fetcher)
      ).rejects.toThrow(`status ${status}`)
    }
  )
})

describe('onboarding follow intent isolation', () => {
  it('lets only the latest click for one exchange account reconcile', () => {
    const ledger = new OnboardingFollowIntentLedger()
    const scope = activeScope()
    const oldFollow = ledger.issue(
      { accountKey: 'bybit:shared-id', source: 'bybit', traderId: 'shared-id' },
      'follow',
      scope
    )!
    const latestUnfollow = ledger.issue(
      { accountKey: 'bybit:shared-id', source: 'bybit', traderId: 'shared-id' },
      'unfollow',
      scope
    )!

    expect(ledger.isCurrent(oldFollow, scope)).toBe(false)
    expect(ledger.isCurrent(latestUnfollow, scope)).toBe(true)
  })

  it('keeps identical trader IDs on different sources independent', () => {
    const ledger = new OnboardingFollowIntentLedger()
    const scope = activeScope()
    const bybit = ledger.issue(
      { accountKey: 'bybit:shared-id', source: 'bybit', traderId: 'shared-id' },
      'follow',
      scope
    )!
    const binance = ledger.issue(
      { accountKey: 'binance:shared-id', source: 'binance', traderId: 'shared-id' },
      'follow',
      scope
    )!

    expect(ledger.isCurrent(bybit, scope)).toBe(true)
    expect(ledger.isCurrent(binance, scope)).toBe(true)
  })

  it('rejects acknowledgements after logout, viewer replacement, or unmount', () => {
    const ledger = new OnboardingFollowIntentLedger()
    const scope = activeScope(4)
    const intent = ledger.issue(
      { accountKey: 'bybit:trader-1', source: 'bybit', traderId: 'trader-1' },
      'follow',
      scope
    )!

    expect(ledger.isCurrent(intent, { ...scope, active: false })).toBe(false)
    expect(ledger.isCurrent(intent, { ...scope, viewerId: null })).toBe(false)
    expect(ledger.isCurrent(intent, { ...scope, revision: 5 })).toBe(false)
  })
})

describe('onboarding follow request ordering', () => {
  it('serializes one account, runs other accounts in parallel, and drains before completion', async () => {
    const sequencer = new OnboardingFollowRequestSequencer()
    const gate = deferred<void>()
    const events: string[] = []

    const first = sequencer.run('bybit:trader-1', async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
    })
    const latest = sequencer.run('bybit:trader-1', async () => {
      events.push('latest')
    })
    const other = sequencer.run('binance:trader-1', async () => {
      events.push('other')
    })

    await other
    expect(events).toEqual(['first:start', 'other'])

    let drained = false
    const draining = sequencer.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.resolve()
    await Promise.all([first, latest, draining])
    expect(events).toEqual(['first:start', 'other', 'first:end', 'latest'])
    expect(drained).toBe(true)
  })
})
