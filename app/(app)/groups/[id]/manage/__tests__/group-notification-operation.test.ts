import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  GroupNotificationOperationLedger,
  GroupNotificationRequestSingleFlight,
  readGroupNotificationAcknowledgement,
} from '../group-notification-operation'

const OPERATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OPERATION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

function intent(
  overrides: Partial<Parameters<GroupNotificationOperationLedger['acquire']>[0]> = {}
) {
  return {
    actorId: '11111111-1111-4111-8111-111111111111',
    groupId: '22222222-2222-4222-8222-222222222222',
    title: 'Update',
    message: 'Hello members',
    ...overrides,
  }
}

describe('group notification operation ledger', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  it('reuses the operation id while a normalized intent has an uncertain outcome', async () => {
    const ids = [OPERATION_A, OPERATION_B]
    const ledger = new GroupNotificationOperationLedger(() => ids.shift()!, null)

    const first = await ledger.acquire(
      intent({ title: '  Cafe\u0301 update  ', message: '  Hello members  ' })
    )
    const retry = await ledger.acquire(intent({ title: 'Café update' }))

    expect(first.operationId).toBe(OPERATION_A)
    expect(retry).toBe(first)
    expect(ids).toEqual([OPERATION_B])
  })

  it('allocates a new operation when payload, group, or viewer scope changes', async () => {
    let counter = 0
    const ledger = new GroupNotificationOperationLedger(
      () => (counter++ === 0 ? OPERATION_A : OPERATION_B),
      null
    )
    const first = await ledger.acquire(intent())
    const changed = await ledger.acquire(intent({ message: 'Different' }))

    expect(changed.operationId).toBe(OPERATION_B)
    expect(changed).not.toBe(first)
    await expect(ledger.acquire(intent())).resolves.toBe(first)
  })

  it('clears only the matching acknowledged operation', async () => {
    const ids = [OPERATION_A, OPERATION_B, OPERATION_C]
    const ledger = new GroupNotificationOperationLedger(() => ids.shift()!, null)
    const first = await ledger.acquire(intent())
    const second = await ledger.acquire(intent({ actorId: '99999999-9999-4999-8999-999999999999' }))

    ledger.complete(first)
    await expect(
      ledger.acquire(intent({ actorId: '99999999-9999-4999-8999-999999999999' }))
    ).resolves.toBe(second)

    ledger.complete(second)
    await expect(
      ledger.acquire(intent({ actorId: '99999999-9999-4999-8999-999999999999' }))
    ).resolves.toMatchObject({ operationId: OPERATION_C })
  })

  it('persists an uncertain operation across page reloads without storing its message', async () => {
    let stored: string | null = null
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    }
    const firstLedger = new GroupNotificationOperationLedger(() => OPERATION_A, storage)
    const first = await firstLedger.acquire(intent({ message: 'private broadcast text' }))
    const reloadedLedger = new GroupNotificationOperationLedger(() => OPERATION_B, storage)
    const replay = await reloadedLedger.acquire(intent({ message: 'private broadcast text' }))

    expect(replay).toEqual(first)
    expect(stored).not.toContain('private broadcast text')

    reloadedLedger.complete(replay)
    const completedReload = new GroupNotificationOperationLedger(() => OPERATION_B, storage)
    await expect(
      completedReload.acquire(intent({ message: 'private broadcast text' }))
    ).resolves.toMatchObject({ operationId: OPERATION_B })
  })

  it('binds the management request and retains uncertain 5xx/network operations', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('await notificationOperationsRef.current.acquire({')
    expect(page).toContain('operation_id: notificationOperation.operationId')
    expect(page).toContain('readGroupNotificationAcknowledgement(data)')
    expect(page).toContain('notificationRequestsRef.current.run(')
    expect(page).toMatch(
      /if \(!res\.ok && res\.status >= 400 && res\.status < 500\) \{[\s\S]*notificationOperationsRef\.current\.complete\(notificationOperation\)/
    )
    expect(page).not.toMatch(
      /catch \([^)]*\) \{[\s\S]{0,300}notificationOperationsRef\.current\.complete/
    )
  })

  it('accepts only a complete, internally consistent broadcast ACK', () => {
    expect(
      readGroupNotificationAcknowledgement({
        success: true,
        notified: 3,
        failed: 0,
        total: 3,
        dm_delivered: 2,
        dm_skipped: 1,
        replayed: false,
      })
    ).toEqual({ notified: 3, dmDelivered: 2, dmSkipped: 1, replayed: false })

    expect(
      readGroupNotificationAcknowledgement({
        success: true,
        notified: 3,
        failed: 0,
        total: 3,
        dm_delivered: 2,
        dm_skipped: 0,
        replayed: false,
      })
    ).toBeNull()
    expect(
      readGroupNotificationAcknowledgement({
        success: true,
        notified: 3,
        failed: 0,
        total: 3,
        dm_delivered: 2,
        dm_skipped: 1,
        replayed: false,
        operation_id: OPERATION_A,
      })
    ).toBeNull()
  })

  it('single-flights the physical broadcast request by operation id', async () => {
    let resolve!: (response: Response) => void
    const start = jest.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        })
    )
    const requests = new GroupNotificationRequestSingleFlight()

    const first = requests.run(OPERATION_A, start)
    const doubleClick = requests.run(OPERATION_A, start)
    expect(first.started).toBe(true)
    expect(doubleClick.started).toBe(false)
    expect(doubleClick.promise).toBe(first.promise)
    expect(requests.size).toBe(1)

    await Promise.resolve()
    expect(start).toHaveBeenCalledTimes(1)
    resolve({ ok: true } as Response)
    await expect(first.promise).resolves.toMatchObject({ ok: true })
    expect(requests.size).toBe(0)
  })
})
