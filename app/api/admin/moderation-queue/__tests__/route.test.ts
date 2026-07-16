jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }
    async json() {
      return this._body
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }
  class MockNextRequest {
    url: string
    method: string
    private body: unknown
    constructor(url: string, init: { method?: string; body?: unknown } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.body = init.body
    }
    async json() {
      return this.body
    }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRpc = jest.fn()
const mockFrom = jest.fn(() => {
  throw new Error('POST moderation must not use direct table writes')
})

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth: (handler: Function) => async (request: unknown) => {
    const { NextResponse } = require('next/server')
    try {
      return await handler({
        admin: {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          email: 'admin@example.com',
        },
        supabase: { rpc: mockRpc, from: mockFrom },
        request,
      })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Internal error' },
        { status: (error as { statusCode?: number }).statusCode ?? 500 }
      )
    }
  },
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: unknown) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json({ success: true, data })
  },
}))

jest.mock('@/lib/api/errors', () => ({
  ApiError: class MockApiError extends Error {
    statusCode: number
    constructor(message: string, options: number | { code?: string } = 500) {
      super(message)
      this.statusCode =
        typeof options === 'number' ? options : options.code === 'DUPLICATE_ACTION' ? 409 : 500
    }
    static validation(message: string) {
      return new this(message, 400)
    }
    static forbidden(message: string) {
      return new this(message, 403)
    }
    static notFound(message: string) {
      return new this(message, 404)
    }
    static database(message: string) {
      return new this(message, 500)
    }
  },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const CONTENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'
const OPERATION_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const AUTHOR_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STRIKE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

type QueueAction = 'approve' | 'delete' | 'warn' | 'ban'

function request(
  action: QueueAction,
  contentId = CONTENT_ID,
  operationId = OPERATION_ID,
  overrides: Record<string, unknown> = {}
) {
  return new NextRequest('http://localhost/api/admin/moderation-queue', {
    method: 'POST',
    body: {
      content_type: 'comment',
      content_id: contentId,
      action,
      operation_id: operationId,
      ...overrides,
    },
  })
}

function result(action: QueueAction, overrides: Record<string, unknown> = {}) {
  const reportStatus = action === 'approve' ? 'dismissed' : 'resolved'
  const actionTaken = {
    approve: 'approved_content',
    delete: 'content_deleted',
    warn: 'user_warned',
    ban: 'user_banned',
  }[action]
  return {
    action_taken: actionTaken,
    applied: true,
    author_id: AUTHOR_ID,
    content_affected_count: action === 'delete' || action === 'ban' ? 2 : 0,
    content_soft_deleted: action === 'delete' || action === 'ban',
    report_count: 2,
    report_status: reportStatus,
    result_action: action,
    result_content_id: CONTENT_ID,
    result_content_type: 'comment',
    result_operation_id: OPERATION_ID,
    strike_id: action === 'warn' ? STRIKE_ID : null,
    strike_type: action === 'warn' ? 'warning' : null,
    ...overrides,
  }
}

describe('POST /api/admin/moderation-queue atomic moderation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it.each(['approve', 'delete', 'warn', 'ban'] as const)(
    '%s delegates all effects to one service-only RPC and accepts a strict acknowledgement',
    async (action) => {
      mockRpc.mockResolvedValue({ data: [result(action)], error: null })

      const response = await POST(request(action))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(mockRpc).toHaveBeenCalledWith('moderate_report_queue_atomic', {
        p_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        p_content_type: 'comment',
        p_content_id: CONTENT_ID,
        p_action: action,
        p_operation_id: OPERATION_ID,
      })
      expect(mockFrom).not.toHaveBeenCalled()
      expect(body.data.result).toMatchObject({
        applied: true,
        report_status: action === 'approve' ? 'dismissed' : 'resolved',
      })
    }
  )

  it('approval never restores a legacy auto-hidden comment', async () => {
    mockRpc.mockResolvedValue({
      data: [result('approve', { content_soft_deleted: true })],
      error: null,
    })

    const response = await POST(request('approve'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.result.content_soft_deleted).toBe(true)
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [
      'an already soft-deleted row',
      {
        action_taken: 'content_already_absent',
        author_id: AUTHOR_ID,
        content_affected_count: 0,
        content_soft_deleted: true,
      },
    ],
    [
      'a physically missing row',
      {
        action_taken: 'content_already_absent',
        author_id: null,
        content_affected_count: 0,
        content_soft_deleted: null,
      },
    ],
  ])('accepts the exact delete no-op metadata for %s', async (_label, override) => {
    mockRpc.mockResolvedValue({ data: [result('delete', override)], error: null })

    const response = await POST(request('delete'))

    expect(response.status).toBe(200)
  })

  it.each(['approve', 'delete', 'warn', 'ban'] as const)(
    'accepts only canonical latest-batch evidence for an idempotent %s replay',
    async (action) => {
      mockRpc.mockResolvedValue({
        data: [
          result(action, {
            applied: false,
            content_affected_count: 0,
            strike_id: null,
            strike_type: null,
          }),
        ],
        error: null,
      })

      const response = await POST(request(action))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.data.result).toMatchObject({
        applied: false,
        report_count: 2,
        report_status: action === 'approve' ? 'dismissed' : 'resolved',
      })
      expect(body.data.message).toContain('already committed')
    }
  )

  it('canonicalizes uppercase content and operation UUIDs before checking the acknowledgement', async () => {
    mockRpc.mockResolvedValue({ data: [result('approve')], error: null })

    const response = await POST(
      request('approve', CONTENT_ID.toUpperCase(), OPERATION_ID.toUpperCase())
    )

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('moderate_report_queue_atomic', {
      p_actor_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      p_content_type: 'comment',
      p_content_id: CONTENT_ID,
      p_action: 'approve',
      p_operation_id: OPERATION_ID,
    })
  })

  it.each([
    ['wrong status', 'warn', { report_status: 'actioned' }],
    ['missing strike evidence', 'warn', { strike_id: null }],
    ['negative report count', 'warn', { report_count: -1 }],
    ['warn without bound author', 'warn', { author_id: null }],
    ['warn with content mutation', 'warn', { content_affected_count: 1 }],
    [
      'delete claims mutation without affected rows',
      'delete',
      { action_taken: 'content_deleted', content_affected_count: 0 },
    ],
    [
      'delete no-op claims affected rows',
      'delete',
      {
        action_taken: 'content_already_absent',
        content_affected_count: 1,
        content_soft_deleted: true,
      },
    ],
    ['ban claims no affected content', 'ban', { content_affected_count: 0 }],
    ['unexpected field', 'warn', { unexpected: true }],
    ['wrong operation acknowledgement', 'warn', { result_operation_id: STRIKE_ID }],
  ] as const)(
    'fails closed on a malformed RPC acknowledgement: %s',
    async (_label, action, override) => {
      mockRpc.mockResolvedValue({ data: [result(action, override)], error: null })

      const response = await POST(request(action))

      expect(response.status).toBe(500)
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['missing replay evidence', { report_count: 0 }],
    ['missing canonical status', { report_status: null }],
    ['missing canonical effect', { action_taken: null }],
    ['wrong latest action', { action_taken: 'user_banned' }],
    ['repeated strike claim', { strike_id: STRIKE_ID, strike_type: 'warning' }],
  ])('rejects a malformed idempotent replay acknowledgement: %s', async (_label, override) => {
    mockRpc.mockResolvedValue({
      data: [
        result('warn', {
          applied: false,
          content_affected_count: 0,
          strike_id: null,
          strike_type: null,
          ...override,
        }),
      ],
      error: null,
    })

    const response = await POST(request('warn'))

    expect(response.status).toBe(500)
  })

  it.each([
    ['22023', 400],
    ['42501', 403],
    ['P0002', 404],
    ['40001', 409],
    ['XX000', 500],
  ])('maps RPC error %s without attempting a table fallback', async (code, status) => {
    mockRpc.mockResolvedValue({ data: null, error: { code } })

    const response = await POST(request('delete'))

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each(['approve', 'delete', 'warn', 'ban'] as const)(
    'maps a conflicting latest action against %s to HTTP 409',
    async (action) => {
      mockRpc.mockResolvedValue({ data: null, error: { code: '40001' } })

      const response = await POST(request(action))

      expect(response.status).toBe(409)
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  it('rejects a malformed content id before calling the RPC', async () => {
    const response = await POST(request('delete', 'not-a-uuid'))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', undefined],
    ['malformed', 'not-a-uuid'],
  ])('rejects a %s operation_id before calling the RPC', async (_label, operationId) => {
    const response = await POST(
      request('delete', CONTENT_ID, OPERATION_ID, { operation_id: operationId })
    )

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects every extra request-body key instead of accepting client-authority data', async () => {
    const response = await POST(
      request('warn', CONTENT_ID, OPERATION_ID, {
        author_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      })
    )

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
