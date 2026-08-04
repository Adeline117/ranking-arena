import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ChannelMessageSendOperationLedger } from '../channel-message-send-operation'

const OPERATION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OPERATION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OPERATION_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const CHANNEL_ID = '22222222-2222-4222-8222-222222222222'

function intent(
  overrides: Partial<Parameters<ChannelMessageSendOperationLedger['acquire']>[0]> = {}
) {
  return {
    actorId: ACTOR_ID,
    channelId: CHANNEL_ID,
    content: 'hello channel',
    mediaUrl: null,
    mediaType: null,
    mediaName: null,
    replyToId: null,
    ...overrides,
  } as const
}

describe('channel-message send operation ledger', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto })
  })

  it('reuses one operation while the exact send outcome is uncertain', async () => {
    const ids = [OPERATION_A, OPERATION_B]
    const ledger = new ChannelMessageSendOperationLedger(() => ids.shift()!, null)

    const first = await ledger.acquire(intent())
    const replay = await ledger.acquire(intent())

    expect(first).toEqual({
      operation: { operationId: OPERATION_A, fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/) },
      reused: false,
    })
    expect(replay).toEqual({ operation: first.operation, reused: true })
    expect(ids).toEqual([OPERATION_B])
  })

  it('allocates independent operations for viewer, channel, and every payload field', async () => {
    const variants = [
      { actorId: '33333333-3333-4333-8333-333333333333' },
      { channelId: '44444444-4444-4444-8444-444444444444' },
      { content: 'different' },
      { mediaUrl: 'https://example.com/file.png', mediaType: 'image' as const },
      { mediaUrl: 'https://example.com/file.png', mediaType: 'file' as const },
      {
        mediaUrl: 'https://example.com/file.png',
        mediaType: 'file' as const,
        mediaName: 'file.png',
      },
      { replyToId: '55555555-5555-4555-8555-555555555555' },
    ]
    const ids = [OPERATION_A, OPERATION_B, OPERATION_C, ...variants.map(() => crypto.randomUUID())]
    const ledger = new ChannelMessageSendOperationLedger(() => ids.shift()!, null)
    const base = await ledger.acquire(intent())

    for (const variant of variants) {
      const acquired = await ledger.acquire(intent(variant))
      expect(acquired.reused).toBe(false)
      expect(acquired.operation.fingerprint).not.toBe(base.operation.fingerprint)
    }
  })

  it.each([
    { actorId: 'not-a-uuid' },
    { channelId: 'not-a-uuid' },
    { content: '', mediaUrl: null },
    { content: 'x'.repeat(2_001) },
    { mediaUrl: 'http://example.com/file', mediaType: 'file' as const },
    { mediaUrl: null, mediaType: 'file' as const },
    { mediaUrl: 'https://example.com/file', mediaType: null },
    { mediaUrl: 'https://example.com/file', mediaType: 'file' as const, mediaName: '' },
    { replyToId: 'not-a-uuid' },
  ])('rejects invalid operation intent before allocating identity %#', async (variant) => {
    const ledger = new ChannelMessageSendOperationLedger(() => OPERATION_A, null)
    await expect(ledger.acquire(intent(variant))).rejects.toThrow(
      /Invalid channel-message send operation/
    )
  })

  it('persists only opaque identity and clears only exact acknowledgements', async () => {
    let stored: string | null = null
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    }
    const ids = [OPERATION_A, OPERATION_C]
    const firstLedger = new ChannelMessageSendOperationLedger(() => ids.shift()!, storage)
    const first = await firstLedger.acquire(intent())
    const reloaded = new ChannelMessageSendOperationLedger(() => OPERATION_B, storage)
    const replay = await reloaded.acquire(intent())

    expect(replay).toEqual({ operation: first.operation, reused: true })
    expect(stored).toContain(OPERATION_A)
    expect(stored).not.toContain(ACTOR_ID)
    expect(stored).not.toContain(CHANNEL_ID)
    expect(stored).not.toContain('hello channel')

    reloaded.complete(replay.operation)
    await expect(firstLedger.acquire(intent())).resolves.toMatchObject({
      operation: { operationId: OPERATION_C },
      reused: false,
    })
    firstLedger.complete({ ...first.operation, operationId: OPERATION_C })
    const completedReload = new ChannelMessageSendOperationLedger(() => OPERATION_B, storage)
    await expect(completedReload.acquire(intent())).resolves.toMatchObject({
      operation: { operationId: OPERATION_B },
      reused: false,
    })
  })

  it('binds the page to synchronous scope exclusion and conservative retry cleanup', () => {
    const page = readFileSync(join(__dirname, '../page.tsx'), 'utf8')

    expect(page).toContain('sendInFlightRef.current.has(inFlightKey)')
    expect(page).toContain('sendInFlightRef.current.add(inFlightKey)')
    expect(page).toContain('await sendOperationsRef.current.acquire(intent)')
    expect(page).toContain('operation_id: sendRequest.operationId')
    expect(page).toContain('userIdRef.current === operationActorId')
    expect(page).toContain('channelIdRef.current === operationChannelId')
    expect(page).toContain('viewerKeyRef.current === operationViewerKey')
    expect(page).toContain('sessionGenerationRef.current === operationSessionGeneration')
    expect(page).toMatch(
      /if \(acknowledgement\) \{[\s\S]*sendOperationsRef\.current\.complete\(sendRequest\)/
    )
    expect(page).toMatch(
      /if \(!res\.ok && res\.status >= 400 && res\.status < 500\) \{[\s\S]*sendOperationsRef\.current\.complete\(sendRequest\)/
    )
    expect(page).not.toMatch(
      /catch \{[\s\S]{0,500}sendOperationsRef\.current\.complete\(sendRequest\)/
    )
    expect(page).toContain('setTimeout(() => requestController.abort(), 20_000)')
  })
})
