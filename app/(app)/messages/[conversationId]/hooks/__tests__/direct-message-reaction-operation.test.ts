import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DirectMessageReactionOperationLedger } from '../direct-message-reaction-operation'

const OPERATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OPERATION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'

function intent(
  overrides: Partial<Parameters<DirectMessageReactionOperationLedger['acquire']>[0]> = {}
) {
  return {
    actorId: ACTOR_ID,
    conversationId: CONVERSATION_ID,
    messageId: MESSAGE_ID,
    emoji: '🔥',
    ...overrides,
  }
}

describe('direct-message reaction operation ledger', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  it('reuses one operation while the same reaction outcome is uncertain', async () => {
    const ids = [OPERATION_A, OPERATION_B]
    const ledger = new DirectMessageReactionOperationLedger(() => ids.shift()!, null)

    const first = await ledger.acquire(intent())
    const retry = await ledger.acquire(intent())

    expect(first).toEqual({
      operation: { operationId: OPERATION_A, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      reused: false,
    })
    expect(retry).toEqual({ operation: first.operation, reused: true })
    expect(ids).toEqual([OPERATION_B])
  })

  it('allocates independent operations for viewer, conversation, message, and emoji scope', async () => {
    const ids = [OPERATION_A, OPERATION_B, OPERATION_C]
    const ledger = new DirectMessageReactionOperationLedger(() => ids.shift()!, null)
    const first = await ledger.acquire(intent())
    const otherEmoji = await ledger.acquire(intent({ emoji: '👍' }))
    const otherMessage = await ledger.acquire(
      intent({ messageId: '44444444-4444-4444-8444-444444444444' })
    )

    expect(first.operation.operationId).toBe(OPERATION_A)
    expect(otherEmoji.operation.operationId).toBe(OPERATION_B)
    expect(otherMessage.operation.operationId).toBe(OPERATION_C)
  })

  it('clears only the exact acknowledged operation', async () => {
    const ids = [OPERATION_A, OPERATION_B, OPERATION_C]
    const ledger = new DirectMessageReactionOperationLedger(() => ids.shift()!, null)
    const first = await ledger.acquire(intent())
    const second = await ledger.acquire(intent({ emoji: '👍' }))

    ledger.complete(first.operation)
    await expect(ledger.acquire(intent({ emoji: '👍' }))).resolves.toEqual({
      operation: second.operation,
      reused: true,
    })

    ledger.complete(second.operation)
    await expect(ledger.acquire(intent({ emoji: '👍' }))).resolves.toMatchObject({
      operation: { operationId: OPERATION_C },
      reused: false,
    })
  })

  it('persists uncertain identity without storing participant or reaction details', async () => {
    let stored: string | null = null
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    }
    const firstLedger = new DirectMessageReactionOperationLedger(() => OPERATION_A, storage)
    const first = await firstLedger.acquire(intent())
    const reloadedLedger = new DirectMessageReactionOperationLedger(() => OPERATION_B, storage)
    const replay = await reloadedLedger.acquire(intent())

    expect(replay).toEqual({ operation: first.operation, reused: true })
    expect(stored).toContain(OPERATION_A)
    expect(stored).not.toContain(ACTOR_ID)
    expect(stored).not.toContain(CONVERSATION_ID)
    expect(stored).not.toContain(MESSAGE_ID)
    expect(stored).not.toContain('🔥')

    reloadedLedger.complete(replay.operation)
    const completedReload = new DirectMessageReactionOperationLedger(() => OPERATION_B, storage)
    await expect(completedReload.acquire(intent())).resolves.toMatchObject({
      operation: { operationId: OPERATION_B },
      reused: false,
    })
  })

  it('binds hook retries and only clears definitive outcomes', () => {
    const hook = readFileSync(join(__dirname, '../useConversationMessages.ts'), 'utf8')

    expect(hook).toContain('await reactionOperationsRef.current.acquire({')
    expect(hook).toContain('operation_id: reactionRequest.operationId')
    expect(hook).toMatch(
      /if \(reactions\) \{[\s\S]*reactionOperationsRef\.current\.complete\(reactionRequest\)/
    )
    expect(hook).toMatch(
      /if \(!result\.ok && result\.status >= 400 && result\.status < 500\) \{[\s\S]*reactionOperationsRef\.current\.complete\(reactionRequest\)/
    )
    expect(hook).not.toMatch(/catch \{[\s\S]{0,350}reactionOperationsRef\.current\.complete/)
  })
})
