/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const SENDER_ID = '11111111-1111-4111-8111-111111111111'
const RECEIVER_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const MESSAGE_ID = '44444444-4444-4444-8444-444444444444'
const REPLY_ID = '55555555-5555-4555-8555-555555555555'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockTraceMessage = jest.fn()

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

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: SENDER_ID, email: 'sender@example.com' },
        supabase: { from: mockFrom, rpc: mockRpc },
        request,
      }),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
  traceMessage: (...args: unknown[]) => mockTraceMessage(...args),
}))

import { POST } from '../route'

function request(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    conversation_id: CONVERSATION_ID,
    sender_id: SENDER_ID,
    receiver_id: RECEIVER_ID,
    content: 'hello',
    read: false,
    read_at: null,
    created_at: '2026-07-29T20:00:00.000+00:00',
    deleted_at: null,
    media_url: null,
    media_type: null,
    media_name: null,
    reply_to_id: null,
    ...overrides,
  }
}

function successAck(overrides: Record<string, unknown> = {}) {
  return {
    allowed: true,
    conversation_id: CONVERSATION_ID,
    message: message(),
    success: true,
    ...overrides,
  }
}

describe('POST /api/messages atomic authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: successAck(), error: null })
  })

  it('sends through one atomic permission, quota, conversation and insert authority', async () => {
    const response = await POST(request({ receiverId: RECEIVER_ID, content: ' hello ' }))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      success: true,
      conversation_id: CONVERSATION_ID,
      message: message(),
    })
    expect(mockRpc).toHaveBeenCalledWith('send_direct_message_atomic', {
      p_sender_id: SENDER_ID,
      p_receiver_id: RECEIVER_ID,
      p_content: 'hello',
      p_media_url: null,
      p_media_type: null,
      p_media_name: null,
      p_reply_to_id: null,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('preserves the authoritative non-mutual limit denial', async () => {
    mockRpc.mockResolvedValue({
      data: { allowed: false, reason: 'LIMIT_REACHED', sent_count: 3, success: false },
      error: null,
    })

    const response = await POST(request({ receiverId: RECEIVER_ID, content: 'hello' }))

    expect(response.status).toBe(403)
    await expect(response.json()).resolves.toEqual({
      error: 'You are not mutual followers. You can only send 3 messages before they reply.',
      error_code: 'PERMISSION_DENIED',
      limit_reached: true,
      sent_count: 3,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects an invalid reply atomically instead of silently sending a plain message', async () => {
    mockRpc.mockResolvedValue({
      data: { allowed: false, reason: 'INVALID_REPLY_TARGET', success: false },
      error: null,
    })

    const response = await POST(
      request({ receiverId: RECEIVER_ID, content: 'reply', reply_to_id: REPLY_ID })
    )

    expect(response.status).toBe(400)
    expect(mockRpc).toHaveBeenCalledWith(
      'send_direct_message_atomic',
      expect.objectContaining({ p_reply_to_id: REPLY_ID })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000' } }],
    ['missing ACK', { data: null, error: null }],
    ['extra ACK field', { data: { ...successAck(), legacy: true }, error: null }],
    [
      'wrong sender',
      {
        data: successAck({ message: message({ sender_id: RECEIVER_ID }) }),
        error: null,
      },
    ],
    [
      'malformed timestamp',
      {
        data: successAck({ message: message({ created_at: 'later' }) }),
        error: null,
      },
    ],
    [
      'contradictory limit',
      {
        data: { allowed: false, reason: 'LIMIT_REACHED', sent_count: 2, success: false },
        error: null,
      },
    ],
  ])('fails closed on a %s without a direct-write fallback', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await POST(request({ receiverId: RECEIVER_ID, content: 'hello' }))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('validates and acknowledges media identity exactly', async () => {
    mockRpc.mockResolvedValue({
      data: successAck({
        message: message({
          content: 'photo',
          media_url: 'https://cdn.example.com/photo.png',
          media_type: 'image',
          media_name: 'photo.png',
        }),
      }),
      error: null,
    })

    const response = await POST(
      request({
        receiverId: RECEIVER_ID,
        content: 'photo',
        media_url: 'https://cdn.example.com/photo.png',
        media_type: 'image',
        media_name: 'photo.png',
      })
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith(
      'send_direct_message_atomic',
      expect.objectContaining({
        p_media_url: 'https://cdn.example.com/photo.png',
        p_media_type: 'image',
        p_media_name: 'photo.png',
      })
    )
  })

  it('contains no route-owned send mutation fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/messages/route.ts'), 'utf8')
    const post = source.slice(source.indexOf('export const POST'))

    expect(post).toContain("'send_direct_message_atomic'")
    expect(post).not.toContain(".from('conversations')")
    expect(post).not.toContain(".from('direct_messages')")
    expect(post).not.toContain('.insert(')
  })
})
