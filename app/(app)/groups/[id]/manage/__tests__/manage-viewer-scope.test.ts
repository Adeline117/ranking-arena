import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import {
  advanceGroupManageResourceScope,
  GroupManageParamsSourceLedger,
  groupManageOwnerKey,
  isGroupManageViewerCurrent,
  type GroupManageOwnerScope,
} from '../manage-viewer-scope'

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const GROUP_1 = '33333333-3333-4333-8333-333333333333'
const GROUP_2 = '44444444-4444-4444-8444-444444444444'

function token(subject: string): string {
  const payload = Buffer.from(JSON.stringify({ sub: subject }), 'utf8').toString('base64url')
  return `header.${payload}.signature`
}

function ownerScope(
  actorId: string,
  sessionGeneration: number,
  overrides: Partial<GroupManageOwnerScope> = {}
): GroupManageOwnerScope {
  return {
    userId: actorId,
    viewerKey: `user:${actorId}`,
    sessionGeneration,
    paramsRevision: 1,
    groupId: GROUP_1,
    resourceGeneration: 2,
    ...overrides,
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe('group manage params source CAS', () => {
  it('accepts only the newest Promise source when A and B resolve out of order', async () => {
    const ledger = new GroupManageParamsSourceLedger()
    const paramsA = deferred<{ id: string }>()
    const paramsB = deferred<{ id: string }>()
    const sourceA = ledger.capture(paramsA.promise)
    expect(ledger.capture(paramsA.promise)).toEqual(sourceA)
    const sourceB = ledger.capture(paramsB.promise)
    const committed: string[] = []

    const resolveSource = async (source: typeof sourceA, params: Promise<{ id: string }>) => {
      const result = await params
      if (ledger.isCurrent(source)) committed.push(result.id)
    }
    const pendingA = resolveSource(sourceA, paramsA.promise)
    const pendingB = resolveSource(sourceB, paramsB.promise)

    paramsB.resolve({ id: GROUP_2 })
    await pendingB
    paramsA.resolve({ id: GROUP_1 })
    await pendingA

    expect(sourceB.paramsRevision).toBe(sourceA.paramsRevision + 1)
    expect(committed).toEqual([GROUP_2])
  })

  it('advances for an A-to-A replacement Promise even when the resolved id is identical', () => {
    const ledger = new GroupManageParamsSourceLedger()
    const first = ledger.capture(Promise.resolve({ id: GROUP_1 }))
    const second = ledger.capture(Promise.resolve({ id: GROUP_1 }))

    expect(second.paramsRevision).toBe(first.paramsRevision + 1)
    expect(ledger.isCurrent(first)).toBe(false)
    expect(ledger.isCurrent(second)).toBe(true)
  })
})

describe('group manage resource and viewer ownership', () => {
  beforeEach(() => __resetViewerScopeForTests())

  it('changes owner across pending resolution and G1 to G2 transitions', () => {
    const empty = { paramsRevision: 0, groupId: null, resourceGeneration: 0 }
    const routeOnePending = advanceGroupManageResourceScope(empty, 1, null)
    const groupOne = advanceGroupManageResourceScope(routeOnePending, 1, GROUP_1.toUpperCase())
    const routeTwoPending = advanceGroupManageResourceScope(groupOne, 2, null)
    const groupTwo = advanceGroupManageResourceScope(routeTwoPending, 2, GROUP_2)

    expect(routeOnePending).toEqual({
      paramsRevision: 1,
      groupId: null,
      resourceGeneration: 1,
    })
    expect(groupOne.resourceGeneration).toBe(2)
    expect(routeTwoPending.resourceGeneration).toBe(3)
    expect(groupTwo).toEqual({
      paramsRevision: 2,
      groupId: GROUP_2,
      resourceGeneration: 4,
    })
    expect(advanceGroupManageResourceScope(groupTwo, 2, GROUP_2)).toBe(groupTwo)
  })

  it('includes every viewer, params, and resource generation in the owner key', () => {
    const scope = ownerScope(ACTOR_A, 7)
    const baseline = groupManageOwnerKey(scope)

    for (const changed of [
      ownerScope(ACTOR_B, 7),
      ownerScope(ACTOR_A, 8),
      ownerScope(ACTOR_A, 7, { paramsRevision: 2 }),
      ownerScope(ACTOR_A, 7, { groupId: GROUP_2 }),
      ownerScope(ACTOR_A, 7, { resourceGeneration: 3 }),
    ]) {
      expect(groupManageOwnerKey(changed)).not.toBe(baseline)
    }
  })

  it('rejects pending/logout, A-to-A reauthentication, and G1-to-G2 late work', () => {
    const initial = synchronizeViewerScope(true, ACTOR_A)
    const request = ownerScope(ACTOR_A, initial.sessionGeneration)
    expect(isGroupManageViewerCurrent(request, request, token(ACTOR_A))).toBe(true)

    beginViewerTransition(null)
    expect(isGroupManageViewerCurrent(request, request, token(ACTOR_A))).toBe(false)

    const restored = commitViewerTransition(1, ACTOR_A)
    expect(restored).toBeNull()
    const nextTransition = beginViewerTransition(ACTOR_A)
    const reauthenticated = commitViewerTransition(nextTransition, ACTOR_A)!
    const sameActorNextSession = ownerScope(ACTOR_A, reauthenticated.sessionGeneration)
    expect(isGroupManageViewerCurrent(request, sameActorNextSession, token(ACTOR_A))).toBe(false)

    const groupTwo = { ...sameActorNextSession, groupId: GROUP_2, resourceGeneration: 4 }
    expect(isGroupManageViewerCurrent(sameActorNextSession, groupTwo, token(ACTOR_A))).toBe(false)
  })
})
