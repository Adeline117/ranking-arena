import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
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
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { rpc: mockRpc, from: mockFrom },
        request,
      }),
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: (...args: unknown[]) => mockLoggerError(...args) },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'
const REACTION_ID = '44444444-4444-4444-8444-444444444444'
const NOTIFICATION_ID = '55555555-5555-4555-8555-555555555555'
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

function validBody(overrides: Record<string, unknown> = {}) {
  return { operation_id: OPERATION_ID, emoji: '🔥', ...overrides }
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    operation_id: OPERATION_ID,
    actor_id: ACTOR_ID,
    message_id: MESSAGE_ID,
    conversation_id: CONVERSATION_ID,
    reaction_id: REACTION_ID,
    emoji: '🔥',
    action: 'added',
    changed: true,
    counts: { '👍': 2, '🔥': 1 },
    user_emojis: ['🔥'],
    notification_id: NOTIFICATION_ID,
    notification_created: true,
    applied: true,
    ...overrides,
  }
}

function request(body: unknown = validBody(), messageId = MESSAGE_ID): NextRequest {
  return new NextRequest(`http://localhost/api/messages/${messageId}/react`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function rawRequest(rawBody: string, messageId = MESSAGE_ID): NextRequest {
  return new NextRequest(`http://localhost/api/messages/${messageId}/react`, {
    method: 'POST',
    body: rawBody,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRpc.mockResolvedValue({ data: successResult(), error: null })
})

describe('POST /api/messages/[messageId]/react atomic boundary', () => {
  it('normalizes IDs and binds exactly one reaction RPC', async () => {
    const response = await POST(
      request(validBody({ operation_id: OPERATION_ID.toUpperCase() }), MESSAGE_ID.toUpperCase())
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: true,
      data: {
        operationId: OPERATION_ID,
        messageId: MESSAGE_ID,
        action: 'added',
        emoji: '🔥',
        counts: { '👍': 2, '🔥': 1 },
        userEmojis: ['🔥'],
        replayed: false,
      },
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('toggle_direct_message_reaction_atomic', {
      p_operation_id: OPERATION_ID,
      p_message_id: MESSAGE_ID,
      p_actor_id: ACTOR_ID,
      p_emoji: '🔥',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns the same canonical state for a replay', async () => {
    mockRpc.mockResolvedValue({ data: successResult({ applied: false }), error: null })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { action: 'added', operationId: OPERATION_ID, replayed: true },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['missing operation', { emoji: '🔥' }],
    ['invalid operation', validBody({ operation_id: 'not-a-uuid' })],
    ['missing emoji', { operation_id: OPERATION_ID }],
    ['unknown emoji', validBody({ emoji: '✅' })],
    ['emoji with suffix', validBody({ emoji: '🔥x' })],
    ['unexpected actor', { ...validBody(), actor_id: ACTOR_ID }],
  ])('rejects %s before opening the atomic boundary', async (_name, body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and message ids before the RPC', async () => {
    const malformed = await POST(rawRequest('{'))
    const invalidMessage = await POST(request(validBody(), 'not-a-uuid'))

    expect(malformed.status).toBe(400)
    expect(invalidMessage.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400, 'Invalid reaction request'],
    ['ACTOR_UNAVAILABLE', 403, 'No permission to react to this message'],
    ['PARTICIPANT_UNAVAILABLE', 403, 'No permission to react to this message'],
    ['FORBIDDEN', 403, 'No permission to react to this message'],
    ['BLOCKED', 403, 'No permission to react to this message'],
    ['MESSAGE_NOT_FOUND', 404, 'Message not found'],
    ['OPERATION_CONFLICT', 409, 'Operation id conflicts with another request'],
  ] as const)('maps %s to a stable private response', async (reason, status, message) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: message })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed on database errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'serialization failure' },
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['null result', null],
    ['unknown failure', { success: false, reason: 'UNKNOWN' }],
    ['extra field', successResult({ extra: true })],
    ['wrong operation', successResult({ operation_id: REACTION_ID })],
    ['wrong actor', successResult({ actor_id: REACTION_ID })],
    ['wrong message', successResult({ message_id: REACTION_ID })],
    ['wrong emoji', successResult({ emoji: '👍', user_emojis: ['👍'] })],
    ['unknown count emoji', successResult({ counts: { '🔥': 1, '✅': 1 } })],
    ['zero count', successResult({ counts: { '🔥': 0 } })],
    ['duplicate user emoji', successResult({ user_emojis: ['🔥', '🔥'] })],
    ['added without own emoji', successResult({ user_emojis: [] })],
    [
      'removed with own emoji',
      successResult({
        action: 'removed',
        user_emojis: ['🔥'],
        notification_id: null,
        notification_created: false,
      }),
    ],
    ['created notification without id', successResult({ notification_id: null })],
    [
      'removed notification side effect',
      successResult({ action: 'removed', user_emojis: [], notification_created: true }),
    ],
  ])('fails closed on %s', async (_name, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('contains no route-level service table reads, writes, or async notification', () => {
    const source = readFileSync(join(__dirname, '../route.ts'), 'utf8')

    expect(source).toContain(".rpc('toggle_direct_message_reaction_atomic'")
    expect(source).not.toMatch(/\.from\(/)
    expect(source).not.toContain('sendNotification')
    expect(source).not.toContain('getUserHandle')
    expect(source).not.toContain('fireAndForget')
  })
})
