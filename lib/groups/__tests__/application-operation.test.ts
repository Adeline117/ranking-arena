import { webcrypto } from 'node:crypto'
import {
  __resetGroupApplicationOperationsForTests,
  acquireGroupApplicationOperation,
  canonicalizeGroupProfileEditPayload,
  completeGroupApplicationOperation,
  groupProfileEditReviewScope,
  groupProfileEditSubmitScope,
  isCurrentGroupApplicationOperation,
  isExactApproveGroupProfileEditAck,
  isExactRejectGroupApplicationAck,
  isExactRejectGroupProfileEditAck,
  isExactSubmitGroupApplicationAck,
  isExactSubmitGroupProfileEditAck,
  runGroupApplicationSingleFlight,
  startGroupApplicationSingleFlight,
} from '../application-operation'

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333'
const GROUP_ID = '44444444-4444-4444-8444-444444444444'

describe('group-application client operation ledger', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  beforeEach(() => {
    __resetGroupApplicationOperationsForTests()
    window.localStorage.clear()
  })

  it('reuses one UUID for the same actor/intent and single-flights the physical request', async () => {
    const intent = { application_id: APPLICATION_ID, decision: 'reject', reason: 'same' }
    const first = await acquireGroupApplicationOperation(
      `review:${ACTOR_A}:${APPLICATION_ID}`,
      ACTOR_A,
      intent
    )
    const second = await acquireGroupApplicationOperation(
      `review:${ACTOR_A}:${APPLICATION_ID}`,
      ACTOR_A,
      { reason: 'same', decision: 'reject', application_id: APPLICATION_ID }
    )
    const task = jest.fn(async () => 'ack')

    const [firstResult, secondResult] = await Promise.all([
      runGroupApplicationSingleFlight(first, task),
      runGroupApplicationSingleFlight(second, task),
    ])

    expect(second.operationId).toBe(first.operationId)
    expect(firstResult).toBe('ack')
    expect(secondResult).toBe('ack')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('rotates on actor/intent changes and a stale completion cannot clear the replacement', async () => {
    const scopeA = `review:${ACTOR_A}:${APPLICATION_ID}`
    const first = await acquireGroupApplicationOperation(scopeA, ACTOR_A, {
      decision: 'reject',
      reason: 'first',
    })
    const replacement = await acquireGroupApplicationOperation(scopeA, ACTOR_A, {
      decision: 'reject',
      reason: 'second',
    })
    const otherActor = await acquireGroupApplicationOperation(
      `review:${ACTOR_B}:${APPLICATION_ID}`,
      ACTOR_B,
      { decision: 'reject', reason: 'first' }
    )

    completeGroupApplicationOperation(first)

    expect(replacement.operationId).not.toBe(first.operationId)
    expect(otherActor.operationId).not.toBe(first.operationId)
    expect(isCurrentGroupApplicationOperation(replacement)).toBe(true)
    expect(isCurrentGroupApplicationOperation(first)).toBe(false)
  })

  it('retains the UUID for non-exact acknowledgements and clears only an exact one', async () => {
    const operation = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
      name: '😀 Group',
    })
    expect(isExactRejectGroupApplicationAck({ success: true }, operation)).toBe(false)

    const retained = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
      name: '😀 Group',
    })
    expect(retained.operationId).toBe(operation.operationId)

    const exactAck = {
      success: true,
      message: 'ok',
      operation_id: operation.operationId,
      application: {
        id: APPLICATION_ID,
        applicant_id: ACTOR_A,
        name: '😀 Group',
        name_en: null,
        description: null,
        description_en: null,
        avatar_url: null,
        role_names: null,
        rules_json: null,
        rules: null,
        is_premium_only: false,
        status: 'pending',
        created_at: '2026-07-16T12:00:00.000Z',
      },
    }
    expect(isExactSubmitGroupApplicationAck(exactAck, operation)).toBe(true)
    completeGroupApplicationOperation(operation)

    const next = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
      name: '😀 Group',
    })
    expect(next.operationId).not.toBe(operation.operationId)
  })

  it.each(['set', 'get', 'invalid'] as const)(
    'keeps the in-document operation stable when storage is degraded by %s',
    async (failure) => {
      let restore: (() => void) | undefined
      if (failure === 'set') {
        const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new DOMException('quota', 'QuotaExceededError')
        })
        restore = () => spy.mockRestore()
      } else if (failure === 'get') {
        const spy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
          throw new DOMException('denied', 'SecurityError')
        })
        restore = () => spy.mockRestore()
      } else {
        window.localStorage.setItem('arena:group-application-operations:v1', '{')
      }

      try {
        const first = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
          name: 'stable',
        })
        const second = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
          name: 'stable',
        })
        expect(second.operationId).toBe(first.operationId)
      } finally {
        restore?.()
      }
    }
  )

  it('snapshots a successful persistent read before a later storage failure', async () => {
    const first = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
      name: 'persisted',
    })
    __resetGroupApplicationOperationsForTests()

    const fromPersistentStorage = await acquireGroupApplicationOperation(
      `submit:${ACTOR_A}`,
      ACTOR_A,
      { name: 'persisted' }
    )
    const getSpy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    try {
      const afterFailure = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
        name: 'persisted',
      })
      expect(fromPersistentStorage.operationId).toBe(first.operationId)
      expect(afterFailure.operationId).toBe(first.operationId)
    } finally {
      getSpy.mockRestore()
    }
  })

  it('clears the memory snapshot when persistent storage was cleared', async () => {
    const first = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
      name: 'cleared',
    })
    window.localStorage.clear()

    const replacement = await acquireGroupApplicationOperation(`submit:${ACTOR_A}`, ACTOR_A, {
      name: 'cleared',
    })

    expect(replacement.operationId).not.toBe(first.operationId)
  })

  it('isolates profile-edit submit/review scopes from creation and from each other', () => {
    expect(groupProfileEditSubmitScope(ACTOR_A, GROUP_ID)).toBe(
      `group-profile-edit:submit:v1:${ACTOR_A}:${GROUP_ID}`
    )
    expect(groupProfileEditReviewScope(ACTOR_A, APPLICATION_ID)).toBe(
      `group-profile-edit:review:v1:${ACTOR_A}:${APPLICATION_ID}`
    )
    expect(groupProfileEditSubmitScope(ACTOR_A, GROUP_ID)).not.toBe(`submit:${ACTOR_A}`)
    expect(groupProfileEditReviewScope(ACTOR_A, APPLICATION_ID)).not.toBe(
      `review:${ACTOR_A}:${APPLICATION_ID}`
    )
    expect(() => groupProfileEditSubmitScope(ACTOR_A, 'not-a-uuid')).toThrow(TypeError)
    expect(() => groupProfileEditReviewScope('not-a-uuid', APPLICATION_ID)).toThrow(TypeError)
  })

  it('trims and NFC-normalizes the complete profile-edit snapshot by code point', () => {
    const payload = canonicalizeGroupProfileEditPayload({
      avatar_url: ' https://example.test/cafe\u0301😀 ',
      description: ' de\u0301tail 😀 ',
      description_en: '   ',
      is_premium_only: true,
      name: ' Cafe\u0301 😀 ',
      name_en: null,
      role_names: {
        admin: { en: ' Owne\u0301r ', zh: ' 管理员 ' },
        member: { en: ' Member ', zh: ' 成员 ' },
      },
      rules_json: [
        { en: ' Re\u0301spect 😀 ', zh: ' 尊重 ' },
        { en: '   ', zh: '   ' },
      ],
    })

    expect(payload).toEqual({
      avatar_url: 'https://example.test/café😀',
      description: 'détail 😀',
      description_en: null,
      is_premium_only: true,
      name: 'Café 😀',
      name_en: null,
      role_names: {
        admin: { en: 'Ownér', zh: '管理员' },
        member: { en: 'Member', zh: '成员' },
      },
      rules: '尊重',
      rules_json: [{ en: 'Réspect 😀', zh: '尊重' }],
    })
    expect(Array.from(payload.name!)).toHaveLength(6)

    expect(
      canonicalizeGroupProfileEditPayload({
        avatar_url: null,
        description: null,
        description_en: null,
        is_premium_only: false,
        name: null,
        name_en: ' English-only edit ',
        role_names: null,
        rules_json: null,
      })
    ).toEqual({
      avatar_url: null,
      description: null,
      description_en: null,
      is_premium_only: false,
      name: '',
      name_en: 'English-only edit',
      role_names: null,
      rules: null,
      rules_json: null,
    })
  })

  it('reports single-flight ownership while preserving the legacy promise API', async () => {
    const operation = await acquireGroupApplicationOperation(
      groupProfileEditSubmitScope(ACTOR_A, GROUP_ID),
      ACTOR_A,
      { group_id: GROUP_ID, name: 'same' }
    )
    const pending = new Promise<string>((resolve) => queueMicrotask(() => resolve('ack')))
    const task = jest.fn(() => pending)

    const first = startGroupApplicationSingleFlight(operation, task)
    const second = startGroupApplicationSingleFlight(operation, task)
    const legacy = runGroupApplicationSingleFlight(operation, task)

    expect(first.started).toBe(true)
    expect(second.started).toBe(false)
    expect(second.promise).toBe(first.promise)
    expect(legacy).toBe(first.promise)
    await expect(first.promise).resolves.toBe('ack')
    expect(task).toHaveBeenCalledTimes(1)
  })

  it('returns a boolean CAS result and cannot clear a replacement intent', async () => {
    const scope = groupProfileEditReviewScope(ACTOR_A, APPLICATION_ID)
    const first = await acquireGroupApplicationOperation(scope, ACTOR_A, {
      decision: 'approve',
      reason: null,
    })
    const replacement = await acquireGroupApplicationOperation(scope, ACTOR_A, {
      decision: 'reject',
      reason: 'changed',
    })

    expect(completeGroupApplicationOperation(first)).toBe(false)
    expect(isCurrentGroupApplicationOperation(replacement)).toBe(true)
    expect(completeGroupApplicationOperation(replacement)).toBe(true)
    expect(completeGroupApplicationOperation(replacement)).toBe(false)
  })

  it('accepts only an exact canonical profile-edit submit snapshot', async () => {
    const payload = canonicalizeGroupProfileEditPayload({
      avatar_url: null,
      description: 'Détail 😀',
      description_en: null,
      is_premium_only: false,
      name: 'Café 😀',
      name_en: null,
      role_names: {
        admin: { en: 'Admin', zh: '管理员' },
        member: { en: 'Member', zh: '成员' },
      },
      rules_json: [{ en: 'Respect', zh: '尊重' }],
    })
    const operation = await acquireGroupApplicationOperation(
      groupProfileEditSubmitScope(ACTOR_A, GROUP_ID),
      ACTOR_A,
      { group_id: GROUP_ID, ...payload }
    )
    const application = {
      id: APPLICATION_ID,
      group_id: GROUP_ID,
      applicant_id: ACTOR_A,
      ...payload,
      status: 'pending',
      created_at: '2026-07-16T12:00:00.000Z',
    }
    const acknowledgement = {
      success: true,
      message: 'submitted',
      operation_id: operation.operationId,
      application,
    }

    expect(isExactSubmitGroupProfileEditAck(acknowledgement, operation, GROUP_ID, payload)).toBe(
      true
    )
    expect(
      isExactSubmitGroupProfileEditAck(
        { ...acknowledgement, application: { ...application, name: 'Cafe\u0301 😀' } },
        operation,
        GROUP_ID,
        payload
      )
    ).toBe(false)
    expect(
      isExactSubmitGroupProfileEditAck(
        { ...acknowledgement, application: { ...application, extra: true } },
        operation,
        GROUP_ID,
        payload
      )
    ).toBe(false)
    expect(
      isExactSubmitGroupProfileEditAck(acknowledgement, operation, APPLICATION_ID, payload)
    ).toBe(false)

    const invalidSnapshots: Array<
      [applicationPatch: Record<string, unknown>, expectedPatch: Record<string, unknown>]
    > = [
      [{ name: '😀'.repeat(51) }, { name: '😀'.repeat(51) }],
      [{ name_en: '😀'.repeat(51) }, { name_en: '😀'.repeat(51) }],
      [{ description: '😀'.repeat(501) }, { description: '😀'.repeat(501) }],
      [{ avatar_url: '/relative/avatar.png' }, { avatar_url: '/relative/avatar.png' }],
      [
        { avatar_url: `https://example.test/${'😀'.repeat(2_049)}` },
        { avatar_url: `https://example.test/${'😀'.repeat(2_049)}` },
      ],
      [{ rules: '😀'.repeat(10_001) }, { rules: '😀'.repeat(10_001) }],
      [{ created_at: '2026-07-16 12:00:00' }, {}],
      [{ created_at: '2026-02-30T12:00:00.000Z' }, {}],
      [
        { role_names: { ...payload.role_names!, extra: true } },
        { role_names: { ...payload.role_names!, extra: true } },
      ],
      [
        { rules_json: Array.from({ length: 101 }, () => ({ en: '', zh: 'rule' })) },
        { rules_json: Array.from({ length: 101 }, () => ({ en: '', zh: 'rule' })) },
      ],
    ]
    for (const [applicationPatch, expectedPatch] of invalidSnapshots) {
      expect(
        isExactSubmitGroupProfileEditAck(
          { ...acknowledgement, application: { ...application, ...applicationPatch } },
          operation,
          GROUP_ID,
          { ...payload, ...expectedPatch } as typeof payload
        )
      ).toBe(false)
    }
  })

  it('binds exact approve/reject acknowledgements to app, group, decision, and NFC reason', async () => {
    const approve = await acquireGroupApplicationOperation(
      groupProfileEditReviewScope(ACTOR_A, APPLICATION_ID),
      ACTOR_A,
      { application_id: APPLICATION_ID, decision: 'approve', reason: null }
    )
    const approveAck = {
      success: true,
      message: 'approved',
      operation_id: approve.operationId,
      application: { id: APPLICATION_ID, group_id: GROUP_ID, status: 'approved' },
    }
    expect(isExactApproveGroupProfileEditAck(approveAck, approve, APPLICATION_ID, GROUP_ID)).toBe(
      true
    )
    expect(
      isExactRejectGroupProfileEditAck(approveAck, approve, APPLICATION_ID, GROUP_ID, null)
    ).toBe(false)

    const rejectReason = 'Réason 😀'
    const reject = await acquireGroupApplicationOperation(
      groupProfileEditReviewScope(ACTOR_A, APPLICATION_ID),
      ACTOR_A,
      { application_id: APPLICATION_ID, decision: 'reject', reason: rejectReason }
    )
    const rejectAck = {
      success: true,
      message: 'rejected',
      operation_id: reject.operationId,
      application: {
        id: APPLICATION_ID,
        group_id: GROUP_ID,
        status: 'rejected',
        reject_reason: rejectReason,
      },
    }
    expect(
      isExactRejectGroupProfileEditAck(rejectAck, reject, APPLICATION_ID, GROUP_ID, rejectReason)
    ).toBe(true)
    expect(
      isExactRejectGroupProfileEditAck(
        {
          ...rejectAck,
          application: { ...rejectAck.application, reject_reason: 'Re\u0301ason 😀' },
        },
        reject,
        APPLICATION_ID,
        GROUP_ID,
        rejectReason
      )
    ).toBe(false)
    expect(completeGroupApplicationOperation(approve)).toBe(false)
    expect(isCurrentGroupApplicationOperation(reject)).toBe(true)
  })
})
