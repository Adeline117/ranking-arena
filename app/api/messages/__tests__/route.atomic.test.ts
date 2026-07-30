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
const mockCreateSignedUrls = jest.fn()
const mockTraceMessage = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    headers: Headers
    status: number

    constructor(
      private readonly body: unknown,
      init: { headers?: HeadersInit; status?: number } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { headers?: HeadersInit; status?: number }) {
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
        supabase: {
          from: mockFrom,
          rpc: mockRpc,
          storage: { from: () => ({ createSignedUrls: mockCreateSignedUrls }) },
        },
        request,
      }),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
  traceMessage: (...args: unknown[]) => mockTraceMessage(...args),
}))

import { GET, POST } from '../route'

function request(body: unknown) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

function getRequest(
  parameters: Record<string, string | readonly string[]> = { conversationId: CONVERSATION_ID }
) {
  const nextUrl = new URL('https://example.com/api/messages')
  for (const [key, values] of Object.entries(parameters)) {
    for (const value of typeof values === 'string' ? [values] : values) {
      nextUrl.searchParams.append(key, value)
    }
  }
  return { nextUrl } as never
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

function pageMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: MESSAGE_ID,
    sender_id: RECEIVER_ID,
    receiver_id: SENDER_ID,
    content: 'hello from other',
    read: false,
    read_at: null,
    created_at: '2026-07-29T19:00:00.000+00:00',
    media_url: null,
    media_type: null,
    media_name: null,
    reply_to_id: null,
    reply_preview: null,
    reactions: [{ emoji: '🔥', count: 2, mine: true }],
    ...overrides,
  }
}

function pageAck(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: SENDER_ID,
    conversation_id: CONVERSATION_ID,
    other_user: {
      id: RECEIVER_ID,
      handle: 'counterparty',
      avatar_url: null,
      bio: 'profile',
    },
    cleared_before: null,
    messages: [pageMessage()],
    has_more: false,
    next_cursor: null,
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

describe('GET /api/messages atomic page authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: pageAck(), error: null })
    mockCreateSignedUrls.mockResolvedValue({ data: [], error: null })
    mockFrom.mockImplementation(() => {
      throw new Error('GET must not issue direct table queries')
    })
  })

  it('signs authorized private attachments only after the atomic page acknowledgement', async () => {
    const objectName = `${CONVERSATION_ID}/image/photo.png`
    const storedUrl = `https://project.supabase.co/storage/v1/object/public/chat/${objectName}`
    const signedUrl = `https://project.supabase.co/storage/v1/object/sign/chat/${objectName}?token=fresh`
    mockRpc.mockResolvedValue({
      data: pageAck({
        messages: [pageMessage({ media_url: storedUrl, media_type: 'image' })],
      }),
      error: null,
    })
    mockCreateSignedUrls.mockResolvedValue({
      data: [{ path: objectName, signedUrl, error: null }],
      error: null,
    })

    const response = await GET(getRequest())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.messages[0].media_url).toBe(signedUrl)
    expect(mockCreateSignedUrls).toHaveBeenCalledWith([objectName], 15 * 60)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns one exact participant-bound snapshot from one RPC', async () => {
    const response = await GET(getRequest())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      messages: [pageMessage()],
      otherUser: {
        id: RECEIVER_ID,
        handle: 'counterparty',
        avatar_url: null,
        bio: 'profile',
      },
      cleared_before: null,
      has_more: false,
      next_cursor: null,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('get_direct_message_conversation_page_atomic', {
      p_actor_id: SENDER_ID,
      p_before_created_at: null,
      p_before_id: null,
      p_conversation_id: CONVERSATION_ID,
      p_limit: 50,
    })
  })

  it('binds both cursor fields and the bounded limit into the same RPC', async () => {
    const before = '2026-07-29T20:00:00.000+00:00'
    const beforeId = '77777777-7777-4777-8777-777777777777'

    const response = await GET(
      getRequest({ conversationId: CONVERSATION_ID, before, beforeId, limit: '20' })
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('get_direct_message_conversation_page_atomic', {
      p_actor_id: SENDER_ID,
      p_before_created_at: before,
      p_before_id: beforeId,
      p_conversation_id: CONVERSATION_ID,
      p_limit: 20,
    })
  })

  it.each([
    [{}, 'missing conversation'],
    [{ conversationId: 'not-a-uuid' }, 'invalid conversation'],
    [{ conversationId: CONVERSATION_ID, before: '2026-07-29T20:00:00.000Z' }, 'half cursor'],
    [{ conversationId: CONVERSATION_ID, beforeId: MESSAGE_ID }, 'other half cursor'],
    [
      { conversationId: CONVERSATION_ID, before: 'later', beforeId: MESSAGE_ID },
      'invalid timestamp',
    ],
    [
      {
        conversationId: CONVERSATION_ID,
        before: '2026-07-29T20:00:00.1234567Z',
        beforeId: MESSAGE_ID,
      },
      'timestamp beyond database precision',
    ],
    [{ conversationId: CONVERSATION_ID, limit: '0' }, 'zero limit'],
    [{ conversationId: CONVERSATION_ID, limit: '101' }, 'oversized limit'],
    [{ conversationId: CONVERSATION_ID, limit: '1.5' }, 'fractional limit'],
    [{ conversationId: CONVERSATION_ID, extra: 'true' }, 'unknown parameter'],
    [{ conversationId: [CONVERSATION_ID, CONVERSATION_ID] }, 'duplicate parameter'],
  ])('rejects a strict query with %s (%s)', async (parameters) => {
    const response = await GET(getRequest(parameters))

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: 'Invalid message request' })
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400, 'Invalid message request'],
    ['NOT_FOUND', 404, 'Conversation not found'],
    ['ACTOR_UNAVAILABLE', 403, 'No permission to access this conversation'],
    ['PARTICIPANT_UNAVAILABLE', 403, 'No permission to access this conversation'],
  ])('maps the exact %s denial without fallback reads', async (reason, status, error) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await GET(getRequest())

    expect(response.status).toBe(status)
    await expect(response.json()).resolves.toEqual({ error })
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the atomic RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'serialization failure' } })

    const response = await GET(getRequest())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch messages' })
  })

  it.each([
    ['missing ACK', null],
    ['array ACK', []],
    ['unknown denial', { success: false, reason: 'UNKNOWN' }],
    ['extra denial evidence', { success: false, reason: 'NOT_FOUND', extra: true }],
    ['extra success evidence', { ...pageAck(), extra: true }],
    ['wrong actor', pageAck({ actor_id: RECEIVER_ID })],
    ['wrong conversation', pageAck({ conversation_id: RECEIVER_ID })],
    ['actor as counterparty', pageAck({ other_user: { ...pageAck().other_user, id: SENDER_ID } })],
    ['foreign participant', pageAck({ messages: [pageMessage({ sender_id: REPLY_ID })] })],
    ['duplicate message', pageAck({ messages: [pageMessage(), pageMessage()] })],
    [
      'descending page',
      pageAck({
        messages: [
          pageMessage({ id: MESSAGE_ID, created_at: '2026-07-29T19:01:00.000Z' }),
          pageMessage({ id: REPLY_ID, created_at: '2026-07-29T19:00:00.000Z' }),
        ],
      }),
    ],
    [
      'duplicate reaction emoji',
      pageAck({
        messages: [
          pageMessage({
            reactions: [
              { emoji: '🔥', count: 1, mine: true },
              { emoji: '🔥', count: 1, mine: false },
            ],
          }),
        ],
      }),
    ],
    ['message at clear boundary', pageAck({ cleared_before: '2026-07-29T19:00:00.000Z' })],
    ['has-more without cursor', pageAck({ has_more: true })],
    [
      'mismatched next cursor',
      pageAck({
        has_more: true,
        next_cursor: {
          before: '2026-07-29T19:00:00.000+00:00',
          before_id: REPLY_ID,
        },
      }),
    ],
  ])('rejects %s without a direct-read fallback', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await GET(getRequest())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('rejects page rows that are not strictly before the requested composite cursor', async () => {
    const before = pageMessage().created_at
    mockRpc.mockResolvedValue({ data: pageAck(), error: null })

    const response = await GET(
      getRequest({ conversationId: CONVERSATION_ID, before, beforeId: MESSAGE_ID })
    )

    expect(response.status).toBe(500)
  })

  it('contains no route-owned page query or enrichment fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/messages/route.ts'), 'utf8')
    const get = source.slice(
      source.indexOf('export const GET'),
      source.indexOf('export const POST')
    )

    expect(get).toContain("'get_direct_message_conversation_page_atomic'")
    expect(get).not.toContain(".from('conversations')")
    expect(get).not.toContain(".from('direct_messages')")
    expect(get).not.toContain(".from('message_reactions')")
    expect(get).not.toContain(".from('user_profiles')")
  })
})
