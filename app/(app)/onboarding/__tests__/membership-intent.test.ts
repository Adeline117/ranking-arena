import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  OnboardingMembershipIntentLedger,
  OnboardingMembershipRequestSequencer,
  rollbackOnboardingMembershipIntent,
  sendOnboardingMembershipIntent,
  type OnboardingMembershipIntent,
  type OnboardingMembershipScope,
} from '../membership-intent'

const VIEWER_ID = '10000000-0000-4000-8000-000000000001'
const GROUP_ID = '20000000-0000-4000-8000-000000000002'
const OTHER_GROUP_ID = '30000000-0000-4000-8000-000000000003'
const REQUEST_ID = '40000000-0000-4000-8000-000000000004'

function activeScope(revision = 1): OnboardingMembershipScope {
  return { active: true, revision, viewerId: VIEWER_ID }
}

function issueIntent(
  action: 'join' | 'leave' = 'join',
  scope = activeScope()
): OnboardingMembershipIntent {
  const intent = new OnboardingMembershipIntentLedger().issue(GROUP_ID, action, scope)
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
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

describe('onboarding membership transport contract', () => {
  it.each([
    [{ success: true, action: 'joined', member_count: 8 }, 200],
    [{ success: true, action: 'already_member', member_count: 8, role: 'member' }, 200],
    [{ success: true, action: 'requested', request_id: REQUEST_ID }, 202],
  ])('posts a join to the canonical membership route and accepts %p', async (payload, status) => {
    const fetcher = jest.fn().mockResolvedValue(response(payload, status))
    const intent = issueIntent('join')

    await sendOnboardingMembershipIntent(
      intent,
      'access-token',
      { 'x-csrf-token': 'csrf' },
      fetcher
    )

    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher).toHaveBeenCalledWith(`/api/groups/${GROUP_ID}/membership`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer access-token',
        'x-csrf-token': 'csrf',
      },
      body: '{"action":"join"}',
    })
  })

  it.each([
    { success: true, action: 'left', member_count: 7 },
    { success: true, action: 'not_member' },
  ])('posts a leave with only the action field and accepts %p', async (payload) => {
    const fetcher = jest.fn().mockResolvedValue(response(payload))

    await sendOnboardingMembershipIntent(issueIntent('leave'), 'access-token', {}, fetcher)

    expect(fetcher.mock.calls[0][0]).toBe(`/api/groups/${GROUP_ID}/membership`)
    expect(fetcher.mock.calls[0][1].body).toBe('{"action":"leave"}')
  })

  it.each([
    [{ success: true, action: 'left', member_count: 7 }, 200],
    [{ success: true, action: 'joined' }, 200],
    [{ success: true, action: 'requested', request_id: 'not-a-uuid' }, 202],
    [{ error: 'denied' }, 403],
  ])('fails closed on a rejected or malformed join acknowledgement', async (payload, status) => {
    const fetcher = jest.fn().mockResolvedValue(response(payload, status))

    await expect(
      sendOnboardingMembershipIntent(issueIntent('join'), 'access-token', {}, fetcher)
    ).rejects.toThrow(`status ${status}`)
  })
})

describe('onboarding membership intent isolation', () => {
  it('lets only the latest intent for one group reconcile optimistic state', () => {
    const ledger = new OnboardingMembershipIntentLedger()
    const scope = activeScope()
    const oldJoin = ledger.issue(GROUP_ID, 'join', scope)!
    const latestLeave = ledger.issue(GROUP_ID, 'leave', scope)!
    let joined = new Set<string>()

    if (ledger.isCurrent(oldJoin, scope)) {
      joined = rollbackOnboardingMembershipIntent(joined, oldJoin)
    }
    expect(joined).toEqual(new Set())

    if (ledger.isCurrent(latestLeave, scope)) {
      joined = rollbackOnboardingMembershipIntent(joined, latestLeave)
    }
    expect(joined).toEqual(new Set([GROUP_ID]))
  })

  it('rejects late A acknowledgements after session and lifecycle generations change', () => {
    const ledger = new OnboardingMembershipIntentLedger()
    const originalScope = activeScope(4)
    const intent = ledger.issue(GROUP_ID, 'join', originalScope)!

    expect(ledger.belongsToScope(intent, originalScope)).toBe(true)
    expect(ledger.isCurrent(intent, { ...originalScope, revision: 5 })).toBe(false)
    expect(ledger.isCurrent(intent, { ...originalScope, active: false })).toBe(false)
    expect(
      ledger.isCurrent(intent, {
        active: true,
        revision: originalScope.revision,
        viewerId: '50000000-0000-4000-8000-000000000005',
      })
    ).toBe(false)
  })

  it('does not issue work without an active authenticated viewer', () => {
    const ledger = new OnboardingMembershipIntentLedger()

    expect(ledger.issue(GROUP_ID, 'join', { active: true, revision: 1, viewerId: null })).toBeNull()
    expect(
      ledger.issue(GROUP_ID, 'join', {
        active: false,
        revision: 1,
        viewerId: VIEWER_ID,
      })
    ).toBeNull()
  })
})

describe('onboarding membership request ordering', () => {
  it('serializes one group while allowing another group to proceed', async () => {
    const sequencer = new OnboardingMembershipRequestSequencer()
    const firstGate = deferred<void>()
    const events: string[] = []

    const first = sequencer.run(GROUP_ID, async () => {
      events.push('first:start')
      await firstGate.promise
      events.push('first:end')
    })
    const second = sequencer.run(GROUP_ID, async () => {
      events.push('second:start')
    })
    const otherGroup = sequencer.run(OTHER_GROUP_ID, async () => {
      events.push('other:start')
    })

    await otherGroup
    expect(events).toEqual(['first:start', 'other:start'])

    firstGate.resolve()
    await Promise.all([first, second])
    expect(events).toEqual(['first:start', 'other:start', 'first:end', 'second:start'])
  })

  it('continues the resource chain after an older request rejects', async () => {
    const sequencer = new OnboardingMembershipRequestSequencer()
    const events: string[] = []
    const first = sequencer.run(GROUP_ID, async () => {
      events.push('first')
      throw new Error('network failure')
    })
    const second = sequencer.run(GROUP_ID, async () => {
      events.push('second')
    })

    await expect(first).rejects.toThrow('network failure')
    await second
    expect(events).toEqual(['first', 'second'])
  })

  it('drains already-started and queued work before onboarding completes', async () => {
    const sequencer = new OnboardingMembershipRequestSequencer()
    const gate = deferred<void>()
    const events: string[] = []
    void sequencer.run(GROUP_ID, async () => {
      events.push('first:start')
      await gate.promise
      events.push('first:end')
    })
    void sequencer.run(GROUP_ID, async () => {
      events.push('second')
    })

    let drained = false
    const draining = sequencer.drain().then(() => {
      drained = true
    })
    await Promise.resolve()
    expect(drained).toBe(false)

    gate.resolve()
    await draining
    expect(events).toEqual(['first:start', 'first:end', 'second'])
    expect(drained).toBe(true)
  })
})

describe('onboarding page membership guard', () => {
  it('uses the membership intent boundary and protects the reviewed render contract', () => {
    const source = readFileSync(join(process.cwd(), 'app/(app)/onboarding/page.tsx'), 'utf8')
    const renderSuffix = source.slice(source.indexOf('  if (!mounted || !authChecked)'))
    const completeFlow = source.slice(
      source.indexOf('  const saveAndComplete'),
      source.indexOf('  // Skip the activation flow')
    )
    const unmountCleanup = source.slice(
      source.indexOf('  // Leaving onboarding invalidates'),
      source.indexOf('  const saveAndComplete')
    )

    expect(source).toContain('sendOnboardingMembershipIntent(')
    expect(source).toContain('sendOnboardingFollowIntent(')
    expect(completeFlow.indexOf('await settleFollowIntents()')).toBeGreaterThan(-1)
    expect(completeFlow.indexOf('await settleMembershipIntents()')).toBeGreaterThan(
      completeFlow.indexOf('await settleFollowIntents()')
    )
    expect(completeFlow.indexOf('onboarding_completed: true')).toBeGreaterThan(
      completeFlow.indexOf('await settleMembershipIntents()')
    )
    expect(source).toContain('await settleMembershipIntents()')
    expect(source).not.toContain('swallow individual failures')
    expect(unmountCleanup).toContain('pendingFollowQueue.clear()')
    expect(unmountCleanup).not.toContain('flushFollowQueue(')
    expect(source).not.toContain("fetch('/api/groups/subscribe'")
    expect(createHash('sha256').update(renderSuffix).digest('hex')).toBe(
      'cd18ada823cb8721d2478d93bb5a690d8f59177a10a9726d242fd7d1dc688fe2'
    )
  })
})
