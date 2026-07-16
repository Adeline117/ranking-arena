import { webcrypto } from 'node:crypto'
import {
  __resetGroupApplicationOperationsForTests,
  acquireGroupApplicationOperation,
  completeGroupApplicationOperation,
  isCurrentGroupApplicationOperation,
  isExactRejectGroupApplicationAck,
  isExactSubmitGroupApplicationAck,
  runGroupApplicationSingleFlight,
} from '../application-operation'

const ACTOR_A = '11111111-1111-4111-8111-111111111111'
const ACTOR_B = '22222222-2222-4222-8222-222222222222'
const APPLICATION_ID = '33333333-3333-4333-8333-333333333333'

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
})
