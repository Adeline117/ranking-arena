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
let mockActorId = '11111111-1111-4111-8111-111111111111'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_ID = '33333333-3333-4333-8333-333333333333'
const READ_AT = '2026-07-30T05:00:00.123456+00:00'

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
        user: { id: mockActorId },
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

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    conversation_id: CONVERSATION_ID,
    marked_count: 2,
    read_at: READ_AT,
    ...overrides,
  }
}

function request(body: unknown = { conversationId: CONVERSATION_ID }): NextRequest {
  return new NextRequest('http://localhost/api/messages/read', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function rawRequest(rawBody: string): NextRequest {
  return new NextRequest('http://localhost/api/messages/read', {
    method: 'POST',
    body: rawBody,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockActorId = ACTOR_ID
  mockRpc.mockResolvedValue({ data: successResult(), error: null })
})

describe('POST /api/messages/read atomic boundary', () => {
  it('normalizes the conversation id and calls exactly one mark-read RPC', async () => {
    const response = await POST(request({ conversationId: CONVERSATION_ID.toUpperCase() }))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      ok: true,
      marked_count: 2,
      read_at: READ_AT,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('mark_direct_message_conversation_read_atomic', {
      p_conversation_id: CONVERSATION_ID,
      p_actor_id: ACTOR_ID,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('accepts a zero-change idempotent replay with database time evidence', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({ marked_count: 0 }),
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      marked_count: 0,
      read_at: READ_AT,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['missing conversation', {}],
    ['invalid conversation', { conversationId: 'not-a-uuid' }],
    ['null body', null],
    ['array body', [CONVERSATION_ID]],
    ['unexpected actor', { conversationId: CONVERSATION_ID, actorId: ACTOR_ID }],
  ])('rejects %s before opening the atomic boundary', async (_name, body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and a malformed authenticated identity', async () => {
    const malformed = await POST(rawRequest('{'))
    mockActorId = 'not-a-uuid'
    const invalidActor = await POST(request())

    expect(malformed.status).toBe(400)
    expect(invalidActor.status).toBe(403)
    expect(malformed.headers.get('Cache-Control')).toBe('private, no-store')
    expect(invalidActor.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['NOT_FOUND', 404, 'Conversation not found'],
    ['ACTOR_UNAVAILABLE', 403, 'Permission denied'],
  ] as const)('maps %s to a stable private denial', async (reason, status, message) => {
    mockRpc.mockResolvedValue({ data: { success: false, reason }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(status)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: message })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed on a database error', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: '40001', message: 'serialization failure' },
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Failed to mark as read' })
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['null result', null],
    ['unknown failure', { success: false, reason: 'UNKNOWN' }],
    ['failure with extra field', { success: false, reason: 'NOT_FOUND', extra: true }],
    ['success with extra field', successResult({ extra: true })],
    ['wrong actor', successResult({ actor_id: OTHER_ID })],
    ['wrong conversation', successResult({ conversation_id: OTHER_ID })],
    ['negative count', successResult({ marked_count: -1 })],
    ['fractional count', successResult({ marked_count: 1.5 })],
    ['unsafe count', successResult({ marked_count: Number.MAX_SAFE_INTEGER + 1 })],
    ['string count', successResult({ marked_count: '2' })],
    ['malformed timestamp', successResult({ read_at: 'later' })],
    ['timestamp without offset', successResult({ read_at: '2026-07-30T05:00:00' })],
  ])('fails closed on %s', async (_name, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('contains no route-level membership read, message update, or route clock', () => {
    const source = readFileSync(join(__dirname, '../route.ts'), 'utf8')

    expect(source).toContain(".rpc('mark_direct_message_conversation_read_atomic'")
    expect(source).not.toMatch(/\.from\(/)
    expect(source).not.toContain('.update(')
    expect(source).not.toContain('new Date(')
    expect(source).not.toContain('toISOString()')
  })
})
