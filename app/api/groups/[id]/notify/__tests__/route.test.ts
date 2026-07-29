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
const GROUP_ID = '22222222-2222-4222-8222-222222222222'
const OPERATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const TARGET_A = '33333333-3333-4333-8333-333333333333'
const TARGET_B = '44444444-4444-4444-8444-444444444444'

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    operation_id: OPERATION_ID,
    title: 'Group update',
    message: 'Hello members',
    ...overrides,
  }
}

function successResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    operation_id: OPERATION_ID,
    actor_id: ACTOR_ID,
    group_id: GROUP_ID,
    target_scope: 'all',
    notified: 2,
    total: 2,
    failed: 0,
    dm_delivered: 1,
    dm_skipped: 1,
    dm_skip_reasons: { BLOCKED: 1 },
    applied: true,
    ...overrides,
  }
}

function request(body: unknown = validBody(), groupId = GROUP_ID): NextRequest {
  return new NextRequest(`http://localhost/api/groups/${groupId}/notify`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function rawRequest(rawBody: string, groupId = GROUP_ID): NextRequest {
  return new NextRequest(`http://localhost/api/groups/${groupId}/notify`, {
    method: 'POST',
    body: rawBody,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRpc.mockResolvedValue({ data: successResult(), error: null })
})

describe('POST /api/groups/[id]/notify atomic boundary', () => {
  it('normalizes and binds one explicit-recipient broadcast RPC', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({
        target_scope: 'explicit',
        notified: 2,
        total: 2,
        dm_delivered: 2,
        dm_skipped: 0,
        dm_skip_reasons: {},
      }),
      error: null,
    })

    const response = await POST(
      request(
        validBody({
          operation_id: OPERATION_ID.toUpperCase(),
          title: '  Cafe\u0301 update  ',
          message: '  Hello members  ',
          target_user_ids: [TARGET_B.toUpperCase(), TARGET_A],
        })
      )
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      success: true,
      notified: 2,
      failed: 0,
      total: 2,
      dm_delivered: 2,
      dm_skipped: 0,
      replayed: false,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('broadcast_group_notification_atomic', {
      p_operation_id: OPERATION_ID,
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_title: 'Café update',
      p_message: 'Hello members',
      p_target_user_ids: [TARGET_A, TARGET_B],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('uses null title/targets for an all-member replay without duplicating it', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({ applied: false }),
      error: null,
    })
    const response = await POST(request(validBody({ title: '   ' })))

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ replayed: true, notified: 2 })
    expect(mockRpc).toHaveBeenCalledWith('broadcast_group_notification_atomic', {
      p_operation_id: OPERATION_ID,
      p_actor_id: ACTOR_ID,
      p_group_id: GROUP_ID,
      p_title: null,
      p_message: 'Hello members',
      p_target_user_ids: null,
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['missing operation id', { title: 'x', message: 'hello' }],
    ['invalid operation id', validBody({ operation_id: 'not-a-uuid' })],
    ['blank message', validBody({ message: '   ' })],
    ['long message', validBody({ message: 'x'.repeat(501) })],
    ['long title', validBody({ title: 'x'.repeat(51) })],
    ['empty targets', validBody({ target_user_ids: [] })],
    ['duplicate targets', validBody({ target_user_ids: [TARGET_A, TARGET_A.toUpperCase()] })],
    ['self target', validBody({ target_user_ids: [ACTOR_ID] })],
    ['invalid target', validBody({ target_user_ids: ['not-a-uuid'] })],
    ['unexpected field', { ...validBody(), sender_id: TARGET_A }],
  ])('rejects %s before opening the atomic boundary', async (_name, body) => {
    const response = await POST(request(body))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and group ids before the RPC', async () => {
    const malformed = await POST(rawRequest('{'))
    const invalidGroup = await POST(request(validBody(), 'not-a-uuid'))

    expect(malformed.status).toBe(400)
    expect(invalidGroup.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['INVALID', 400, 'Invalid notification request'],
    ['INVALID_TARGETS', 400, 'Invalid notification request'],
    ['ACTOR_UNAVAILABLE', 403, 'Permission denied'],
    ['PERMISSION_DENIED', 403, 'Permission denied'],
    ['GROUP_NOT_FOUND', 404, 'Group not found'],
    ['GROUP_DISSOLVED', 409, 'The group has been dissolved'],
    ['NO_RECIPIENTS', 400, 'No members to notify'],
    ['TOO_MANY_RECIPIENTS', 409, 'Too many members to notify at once'],
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
      error: { code: '57014', message: 'statement timeout' },
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
    ['extra success field', successResult({ extra: true })],
    ['wrong actor', successResult({ actor_id: TARGET_A })],
    ['wrong group', successResult({ group_id: TARGET_A })],
    ['wrong operation', successResult({ operation_id: TARGET_A })],
    ['wrong scope', successResult({ target_scope: 'explicit' })],
    ['total mismatch', successResult({ total: 1 })],
    ['DM count mismatch', successResult({ dm_delivered: 2 })],
    ['reason count mismatch', successResult({ dm_skip_reasons: {} })],
    ['zero recipients', successResult({ notified: 0, total: 0, dm_delivered: 0, dm_skipped: 0 })],
  ])('fails closed on %s', async (_name, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockLoggerError).toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('contains no route-level service table reads or writes', () => {
    const source = readFileSync(join(__dirname, '../route.ts'), 'utf8')

    expect(source).toContain(".rpc('broadcast_group_notification_atomic'")
    expect(source).not.toMatch(/\.from\(/)
    expect(source).not.toContain('sendNotifications')
    expect(source).not.toContain('direct_messages')
    expect(source).not.toContain('conversations')
  })
})
