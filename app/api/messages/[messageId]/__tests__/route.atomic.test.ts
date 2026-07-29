/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_MESSAGE_ID = '33333333-3333-4333-8333-333333333333'
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockGetAuthUser = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { write: {} },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({ logger: { error: jest.fn() } }))

import { DELETE } from '../route'

function successAck(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    deleted: true,
    already_deleted: false,
    message_id: MESSAGE_ID,
    conversation_id: CONVERSATION_ID,
    deleted_at: '2026-07-29T20:00:00.000Z',
    last_message_at: '2026-07-29T19:59:00.000Z',
    last_message_preview: 'previous message',
    ...overrides,
  }
}

function invoke(messageId = MESSAGE_ID) {
  return DELETE({} as never, { params: Promise.resolve({ messageId }) })
}

describe('DELETE /api/messages/[messageId] atomic authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue({ id: ACTOR_ID })
    mockRpc.mockResolvedValue({ data: successAck(), error: null })
  })

  it('soft-deletes only through the atomic ownership and summary authority', async () => {
    const response = await invoke()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      deleted: true,
      already_deleted: false,
      message_id: MESSAGE_ID,
      conversation_id: CONVERSATION_ID,
      deleted_at: '2026-07-29T20:00:00.000Z',
      last_message_at: '2026-07-29T19:59:00.000Z',
      last_message_preview: 'previous message',
    })
    expect(mockRpc).toHaveBeenCalledWith('delete_direct_message_atomic', {
      p_message_id: MESSAGE_ID,
      p_actor_id: ACTOR_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('accepts an exact idempotent replay acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: successAck({ deleted: false, already_deleted: true }),
      error: null,
    })

    const response = await invoke()

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      deleted: false,
      already_deleted: true,
      message_id: MESSAGE_ID,
    })
  })

  it.each([
    ['NOT_FOUND', 404],
    ['FORBIDDEN', 403],
  ] as const)('maps the authoritative %s denial', async (reason, expectedStatus) => {
    mockRpc.mockResolvedValue({
      data: { success: false, deleted: false, reason },
      error: null,
    })

    const response = await invoke()

    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000' } }],
    ['missing ACK', { data: null, error: null }],
    ['wrong message', { data: successAck({ message_id: OTHER_MESSAGE_ID }), error: null }],
    ['extra field', { data: successAck({ legacy: true }), error: null }],
    [
      'contradictory status',
      { data: successAck({ deleted: true, already_deleted: true }), error: null },
    ],
    ['invalid timestamp', { data: successAck({ deleted_at: 'later' }), error: null }],
  ])('fails closed on a %s without a direct update fallback', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await invoke()

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed message identity before reaching the database', async () => {
    const response = await invoke('not-a-uuid')

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('contains no route-owned ownership pre-read or soft-delete fallback', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'app/api/messages/[messageId]/route.ts'),
      'utf8'
    )

    expect(source).toContain("'delete_direct_message_atomic'")
    expect(source).not.toContain(".from('direct_messages')")
    expect(source).not.toContain('.update(')
  })
})
