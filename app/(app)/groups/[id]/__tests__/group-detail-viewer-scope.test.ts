import {
  __resetViewerScopeForTests,
  beginViewerTransition,
  commitViewerTransition,
  synchronizeViewerScope,
} from '@/lib/auth/viewer-scope'
import {
  advanceGroupDetailResourceScope,
  GroupDetailParamsSourceLedger,
  groupDetailOwnerKey,
  isGroupDetailOwnerCurrent,
  type GroupDetailOwnerScope,
  type GroupDetailResourceScope,
} from '../group-detail-viewer-scope'

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const GROUP_1 = '33333333-3333-4333-8333-333333333333'
const GROUP_2 = '44444444-4444-4444-8444-444444444444'

function token(subject: string, marker: string): string {
  const payload = btoa(JSON.stringify({ sub: subject, marker }))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return `header.${payload}.signature`
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function ownerScope(
  userId: string | null,
  sessionGeneration: number,
  overrides: Partial<GroupDetailOwnerScope> = {}
): GroupDetailOwnerScope {
  return {
    userId,
    viewerKey: userId ? `user:${userId}` : 'anon',
    sessionGeneration,
    paramsRevision: 1,
    groupId: GROUP_1,
    resourceGeneration: 1,
    ...overrides,
  }
}

describe('group detail params source CAS', () => {
  it('drops an older params Promise that resolves after its replacement', async () => {
    const ledger = new GroupDetailParamsSourceLedger()
    const paramsA = deferred<{ id: string }>()
    const paramsB = deferred<{ id: string }>()
    const sourceA = ledger.capture(paramsA.promise)
    expect(ledger.capture(paramsA.promise)).toEqual(sourceA)
    const sourceB = ledger.capture(paramsB.promise)
    let committed = ''

    const resolve = async (source: typeof sourceA, promise: Promise<{ id: string }>) => {
      const value = await promise
      if (ledger.isCurrent(source)) committed = value.id
    }
    const pendingA = resolve(sourceA, paramsA.promise)
    const pendingB = resolve(sourceB, paramsB.promise)
    paramsB.resolve({ id: GROUP_2 })
    await pendingB
    paramsA.resolve({ id: GROUP_1 })
    await pendingA

    expect(committed).toBe(GROUP_2)
    expect(sourceB.paramsRevision).toBe(sourceA.paramsRevision + 1)
  })

  it('advances for a new source even when both resolve to the same group id', () => {
    const ledger = new GroupDetailParamsSourceLedger()
    const first = ledger.capture(Promise.resolve({ id: GROUP_1 }))
    const second = ledger.capture(Promise.resolve({ id: GROUP_1 }))
    expect(second.paramsRevision).toBe(first.paramsRevision + 1)
    expect(ledger.isCurrent(first)).toBe(false)
    expect(ledger.isCurrent(second)).toBe(true)
  })
})

describe('group detail resource and viewer ownership', () => {
  beforeEach(() => __resetViewerScopeForTests())

  it('advances on pending, resolution, same-id source, and G1-to-G2 transitions', () => {
    const empty: GroupDetailResourceScope = {
      paramsRevision: 0,
      groupId: null,
      resourceGeneration: 0,
    }
    const pending = advanceGroupDetailResourceScope(empty, 1, null)
    const group1 = advanceGroupDetailResourceScope(pending, 1, GROUP_1.toUpperCase())
    const same = advanceGroupDetailResourceScope(group1, 1, GROUP_1)
    const sameIdNewSource = advanceGroupDetailResourceScope(same, 2, GROUP_1)
    const group2 = advanceGroupDetailResourceScope(sameIdNewSource, 3, GROUP_2)

    expect(pending.resourceGeneration).toBe(1)
    expect(group1).toEqual({ paramsRevision: 1, groupId: GROUP_1, resourceGeneration: 2 })
    expect(same).toBe(group1)
    expect(sameIdNewSource.resourceGeneration).toBe(3)
    expect(group2.resourceGeneration).toBe(4)
  })

  it('puts every viewer, params, and resource field in the owner key', () => {
    const base = ownerScope(ACTOR_A, 7)
    const variants = [
      ownerScope(ACTOR_B, 7),
      ownerScope(ACTOR_A, 8),
      ownerScope(ACTOR_A, 7, { paramsRevision: 2 }),
      ownerScope(ACTOR_A, 7, { groupId: GROUP_2 }),
      ownerScope(ACTOR_A, 7, { resourceGeneration: 2 }),
    ]
    for (const variant of variants) {
      expect(groupDetailOwnerKey(variant)).not.toBe(groupDetailOwnerKey(base))
    }
  })

  it('rejects A-to-B, A-to-A, pending, G1-to-G2, and same-id params late work', () => {
    const scopeA = synchronizeViewerScope(true, ACTOR_A)
    const expected = ownerScope(ACTOR_A, scopeA.sessionGeneration)
    expect(isGroupDetailOwnerCurrent(expected, expected, token(ACTOR_A, 'a'))).toBe(true)

    const scopeB = synchronizeViewerScope(true, ACTOR_B)
    expect(
      isGroupDetailOwnerCurrent(
        expected,
        ownerScope(ACTOR_B, scopeB.sessionGeneration),
        token(ACTOR_B, 'b')
      )
    ).toBe(false)

    const transition = beginViewerTransition(ACTOR_A)
    expect(
      isGroupDetailOwnerCurrent(expected, ownerScope(null, transition, { groupId: GROUP_1 }), null)
    ).toBe(false)
    const nextA = commitViewerTransition(transition, ACTOR_A)!
    expect(
      isGroupDetailOwnerCurrent(
        expected,
        ownerScope(ACTOR_A, nextA.sessionGeneration),
        token(ACTOR_A, 'new-a')
      )
    ).toBe(false)
    expect(
      isGroupDetailOwnerCurrent(
        ownerScope(ACTOR_A, nextA.sessionGeneration),
        ownerScope(ACTOR_A, nextA.sessionGeneration, { groupId: GROUP_2 }),
        token(ACTOR_A, 'new-a')
      )
    ).toBe(false)
    expect(
      isGroupDetailOwnerCurrent(
        ownerScope(ACTOR_A, nextA.sessionGeneration),
        ownerScope(ACTOR_A, nextA.sessionGeneration, {
          paramsRevision: 2,
          resourceGeneration: 2,
        }),
        token(ACTOR_A, 'new-a')
      )
    ).toBe(false)
  })

  it('allows a resolved anonymous owner only without an access token', () => {
    const anon = synchronizeViewerScope(true, null)
    const expected = ownerScope(null, anon.sessionGeneration)
    expect(isGroupDetailOwnerCurrent(expected, expected, null)).toBe(true)
    expect(isGroupDetailOwnerCurrent(expected, expected, token(ACTOR_A, 'stale'))).toBe(false)
  })
})
