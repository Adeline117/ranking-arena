import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    private readonly body: unknown
    status: number
    headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    method: string
    private readonly rawBody: string

    constructor(url: string, init: { method?: string; body?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.rawBody = init.body ?? ''
    }

    async json() {
      if (!this.rawBody) throw new Error('missing body')
      return JSON.parse(this.rawBody)
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockLoggerError = jest.fn()
const mockTraceMessage = jest.fn()

const SENDER_ID = '11111111-1111-4111-8111-111111111111'
const RECEIVER_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { rpc: typeof mockRpc; from: typeof mockFrom }
        request: unknown
      }) => unknown
    ) =>
    (request: unknown) =>
      handler({
        user: { id: SENDER_ID },
        supabase: { rpc: mockRpc, from: mockFrom },
        request,
      }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))
jest.mock('@/lib/utils/logger', () => ({
  traceMessage: (...args: unknown[]) => mockTraceMessage(...args),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    sender_id: SENDER_ID,
    receiver_id: RECEIVER_ID,
    conversation_id: CONVERSATION_ID,
    receiver_handle: 'receiver',
    can_message: true,
    is_mutual_follow: false,
    message_limit: null,
    created: true,
    ...overrides,
  }
}

function request(body: unknown = { receiverId: RECEIVER_ID }): NextRequest {
  return new NextRequest('http://localhost/api/messages/start', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function rawRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost/api/messages/start', {
    method: 'POST',
    body: rawBody,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRpc.mockResolvedValue({ data: successResult(), error: null })
})

describe('POST /api/messages/start atomic boundary', () => {
  it('normalizes the receiver and binds exactly one conversation-start RPC', async () => {
    const response = await POST(request({ receiverId: RECEIVER_ID.toUpperCase() }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      conversation_id: CONVERSATION_ID,
      sender_id: SENDER_ID,
      receiver_id: RECEIVER_ID,
      can_message: true,
      is_mutual_follow: false,
      message_limit: null,
      receiver_handle: 'receiver',
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('start_direct_message_conversation_atomic', {
      p_sender_id: SENDER_ID,
      p_receiver_id: RECEIVER_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockTraceMessage).toHaveBeenCalledWith({
      event: 'conversation_created',
      conversationId: CONVERSATION_ID,
      senderId: SENDER_ID,
      receiverId: RECEIVER_ID,
      metadata: { created: true, isMutualFollow: false },
    })
  })

  it('returns the exact existing limited conversation without claiming it was created', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({
        can_message: false,
        message_limit: { reached: true, sent: 3, max: 3 },
        created: false,
      }),
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      conversation_id: CONVERSATION_ID,
      can_message: false,
      message_limit: { reached: true, sent: 3, max: 3 },
    })
    expect(mockTraceMessage).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { created: false, isMutualFollow: false } })
    )
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('accepts the bounded non-mutual capacity acknowledgement', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({
        message_limit: { reached: false, sent: 2, max: 3 },
        created: false,
      }),
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      can_message: true,
      is_mutual_follow: false,
      message_limit: { reached: false, sent: 2, max: 3 },
    })
  })

  it.each([
    ['missing receiver', {}],
    ['invalid receiver', { receiverId: 'not-a-uuid' }],
    ['null body', null],
    ['array body', [RECEIVER_ID]],
    ['unexpected sender', { receiverId: RECEIVER_ID, senderId: SENDER_ID }],
  ])('rejects %s before opening the atomic boundary', async (_name, body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toMatchObject({ error_code: 'VALIDATION_ERROR' })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and self-message requests before the RPC', async () => {
    const malformed = await POST(rawRequest('{'))
    const selfMessage = await POST(request({ receiverId: SENDER_ID }))

    expect(malformed.status).toBe(400)
    expect(selfMessage.status).toBe(400)
    expect(malformed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(selfMessage.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [
      'DM_DISABLED',
      403,
      { error: 'This user has disabled direct messages', error_code: 'PERMISSION_DENIED' },
    ],
    ['USER_NOT_FOUND', 404, { error: 'User not found' }],
    ['SENDER_UNAVAILABLE', 403, { error: 'Permission denied', error_code: 'PERMISSION_DENIED' }],
    ['BLOCKED', 403, { error: 'Permission denied', error_code: 'PERMISSION_DENIED' }],
  ] as const)('maps %s to a stable private denial', async (reason, status, body) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual(body)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockTraceMessage).not.toHaveBeenCalled()
  })

  it('fails closed on database errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'serialization failure' },
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Failed to start conversation' })
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockTraceMessage).not.toHaveBeenCalled()
  })

  it.each([
    ['null result', null],
    ['unknown denial', { success: false, reason: 'UNKNOWN' }],
    ['denial with extra field', { success: false, reason: 'BLOCKED', extra: true }],
    ['success with extra field', successResult({ extra: true })],
    ['wrong sender', successResult({ sender_id: CONVERSATION_ID })],
    ['wrong receiver', successResult({ receiver_id: CONVERSATION_ID })],
    ['same participant', successResult({ receiver_id: SENDER_ID })],
    ['invalid conversation', successResult({ conversation_id: 'not-a-uuid' })],
    ['empty receiver handle', successResult({ receiver_handle: '' })],
    ['nullable receiver handle', successResult({ receiver_handle: null })],
    ['denied without reached limit', successResult({ can_message: false })],
    [
      'reached limit still writable',
      successResult({
        message_limit: { reached: true, sent: 3, max: 3 },
        can_message: true,
      }),
    ],
    [
      'available limit denied',
      successResult({
        message_limit: { reached: false, sent: 2, max: 3 },
        can_message: false,
      }),
    ],
    [
      'mutual response with a limit',
      successResult({
        is_mutual_follow: true,
        message_limit: { reached: false, sent: 1, max: 3 },
      }),
    ],
    [
      'created reached-limit conversation',
      successResult({
        can_message: false,
        message_limit: { reached: true, sent: 3, max: 3 },
        created: true,
      }),
    ],
    [
      'under-counted reached limit',
      successResult({
        can_message: false,
        message_limit: { reached: true, sent: 2, max: 3 },
        created: false,
      }),
    ],
    [
      'wrong limit maximum',
      successResult({
        message_limit: { reached: false, sent: 1, max: 4 },
      }),
    ],
  ])('fails closed on %s', async (_name, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockTraceMessage).not.toHaveBeenCalled()
  })

  it('contains no route-level permission, profile, or conversation table query', () => {
    const source = readFileSync(join(__dirname, '../route.ts'), 'utf8')

    expect(source).toContain(".rpc('start_direct_message_conversation_atomic'")
    expect(source).not.toMatch(/\.from\(/)
    expect(source).not.toContain("'check_dm_permission'")
    expect(source).not.toContain('existingConversation')
    expect(source).not.toContain('receiverProfile')
  })
})
