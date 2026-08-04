import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChannelMessageReactionOperationLedger } from '../channel-message-reaction-operation'

const OPERATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OPERATION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333'

function intent(
  overrides: Partial<Parameters<ChannelMessageReactionOperationLedger['acquire']>[0]> = {}
) {
  return {
    actorId: ACTOR_ID,
    channelId: CHANNEL_ID,
    messageId: MESSAGE_ID,
    emoji: '🔥',
    ...overrides,
  }
}

describe('channel-message reaction operation ledger', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  it('reuses one operation while the same toggle outcome is uncertain', async () => {
    const ids = [OPERATION_A, OPERATION_B]
    const ledger = new ChannelMessageReactionOperationLedger(() => ids.shift()!, null)

    const first = await ledger.acquire(intent())
    const replay = await ledger.acquire(intent())

    expect(first).toEqual({
      operation: { operationId: OPERATION_A, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      reused: false,
    })
    expect(replay).toEqual({ operation: first.operation, reused: true })
    expect(ids).toEqual([OPERATION_B])
  })

  it('allocates independent operations for viewer, channel, message, and emoji scope', async () => {
    const ids = [OPERATION_A, OPERATION_B, OPERATION_C]
    const ledger = new ChannelMessageReactionOperationLedger(() => ids.shift()!, null)

    await expect(ledger.acquire(intent())).resolves.toMatchObject({
      operation: { operationId: OPERATION_A },
    })
    await expect(ledger.acquire(intent({ emoji: '👍' }))).resolves.toMatchObject({
      operation: { operationId: OPERATION_B },
    })
    await expect(
      ledger.acquire(intent({ messageId: '44444444-4444-4444-8444-444444444444' }))
    ).resolves.toMatchObject({ operation: { operationId: OPERATION_C } })
  })

  it('persists only opaque operation identity and clears the exact acknowledgement', async () => {
    let stored: string | null = null
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    }
    const firstLedger = new ChannelMessageReactionOperationLedger(() => OPERATION_A, storage)
    const first = await firstLedger.acquire(intent())
    const reloaded = new ChannelMessageReactionOperationLedger(() => OPERATION_B, storage)
    const replay = await reloaded.acquire(intent())

    expect(replay).toEqual({ operation: first.operation, reused: true })
    expect(stored).toContain(OPERATION_A)
    expect(stored).not.toContain(ACTOR_ID)
    expect(stored).not.toContain(CHANNEL_ID)
    expect(stored).not.toContain(MESSAGE_ID)
    expect(stored).not.toContain('🔥')

    reloaded.complete(replay.operation)
    const completedReload = new ChannelMessageReactionOperationLedger(() => OPERATION_B, storage)
    await expect(completedReload.acquire(intent())).resolves.toMatchObject({
      operation: { operationId: OPERATION_B },
      reused: false,
    })
  })

  it('binds the page to one in-flight mutation and stable replay semantics', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('reactionInFlightRef.current.has(inFlightKey)')
    expect(page).toContain('viewerKeyRef.current === operationViewerKey')
    expect(page).toContain('sessionGenerationRef.current === operationSessionGeneration')
    expect(page).toContain('await reactionOperationsRef.current.acquire({')
    expect(page).toContain('operation_id: reactionRequest.operationId')
    expect(page).toMatch(
      /if \(reactions\) \{[\s\S]*reactionOperationsRef\.current\.complete\(reactionRequest\)/
    )
    expect(page).toMatch(
      /if \(!res\.ok && res\.status >= 400 && res\.status < 500\) \{[\s\S]*reactionOperationsRef\.current\.complete\(reactionRequest\)/
    )
    expect(page).not.toMatch(/catch \{[\s\S]{0,500}reactionOperationsRef\.current\.complete/)
  })
})
