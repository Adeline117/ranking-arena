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

type QueryResult = { data?: unknown; error?: { code?: string } | null }

const mockModerateCommentWithRollout = jest.fn()
const mockAutoEscalate = jest.fn()
const mockFrom = jest.fn()
const queues = new Map<string, Array<Record<string, unknown>>>()

function query(result: QueryResult = {}) {
  const resolved = {
    data: Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null,
    error: result.error ?? null,
  }
  const promise = Promise.resolve(resolved)
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in', 'update', 'insert']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.maybeSingle = jest.fn(() => promise)
  chain.then = promise.then.bind(promise)
  return chain
}

function queue(table: string, result: QueryResult = {}) {
  const builder = query(result)
  const tableQueue = queues.get(table) ?? []
  tableQueue.push(builder)
  queues.set(table, tableQueue)
  return builder
}

jest.mock('@/lib/data/comment-mutation-rollout', () => {
  class MockCommentMutationRolloutError extends Error {
    constructor(
      public readonly kind: string,
      public readonly databaseCode?: string,
      public readonly stage?: string
    ) {
      super(`Comment mutation failed: ${kind}`)
      this.name = 'CommentMutationRolloutError'
    }
  }
  return {
    CommentMutationRolloutError: MockCommentMutationRolloutError,
    moderateCommentWithRollout: (...args: unknown[]) => mockModerateCommentWithRollout(...args),
  }
})

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth: (handler: Function) => async (request: unknown) => {
    const { NextResponse } = require('next/server')
    try {
      return await handler({
        admin: { id: 'admin-1', email: 'admin@example.com' },
        supabase: { from: mockFrom },
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
    constructor(message: string, statusCode: number) {
      super(message)
      this.statusCode = statusCode
    }
    static validation(message: string) {
      return new this(message, 400)
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
jest.mock('@/lib/services/moderation', () => ({
  autoEscalate: (...args: unknown[]) => mockAutoEscalate(...args),
}))

import { NextRequest } from 'next/server'
import { CommentMutationRolloutError } from '@/lib/data/comment-mutation-rollout'
import { POST } from '../route'

const COMMENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'
const REPORT_IDS = ['report-1', 'report-2']
const BANNED_AT = '2026-07-15T22:00:00.000Z'

function request(action: 'approve' | 'delete' | 'warn' | 'ban') {
  return new NextRequest('http://localhost/api/admin/moderation-queue', {
    method: 'POST',
    body: {
      content_type: 'comment',
      content_id: COMMENT_ID,
      action,
      ...(action === 'warn' || action === 'ban' ? { author_id: 'author-1' } : {}),
    },
  })
}

function reportAck(status: 'dismissed' | 'resolved', actionTaken: string) {
  return REPORT_IDS.map((id) => ({
    id,
    status,
    resolved_by: 'admin-1',
    resolved_at: BANNED_AT,
    action_taken: actionTaken,
    content_type: 'comment',
    content_id: COMMENT_ID,
  }))
}

function arrangeAction(
  status: 'dismissed' | 'resolved',
  actionTaken: string,
  options: { transition?: QueryResult; ban?: boolean } = {}
) {
  queue('content_reports', { data: REPORT_IDS.map((id) => ({ id })) })
  if (options.ban) {
    queue('user_profiles', {
      data: {
        id: 'author-1',
        banned_at: BANNED_AT,
        banned_reason: 'Banned for reported comment',
        banned_by: 'admin-1',
      },
    })
  }
  const transition = queue(
    'content_reports',
    options.transition ?? { data: reportAck(status, actionTaken) }
  )
  queue('admin_logs', { data: null })
  return transition
}

describe('POST /api/admin/moderation-queue comment moderation', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    queues.clear()
    jest.spyOn(Date.prototype, 'toISOString').mockReturnValue(BANNED_AT)
    mockFrom.mockImplementation((table: string) => {
      const builder = queues.get(table)?.shift()
      if (!builder) throw new Error(`Unexpected query for ${table}`)
      return builder
    })
    mockModerateCommentWithRollout.mockResolvedValue({
      post_id: 'post-1',
      affected_count: 2,
      comment_count: 3,
    })
  })

  it.each([
    [
      'approve',
      'restore_auto_hidden',
      'Approved in moderation queue',
      'dismissed',
      'approved_content',
    ],
    ['delete', 'soft_delete', 'Deleted from moderation queue', 'resolved', 'content_deleted'],
    ['ban', 'soft_delete', 'Author banned for reported comment', 'resolved', 'user_banned'],
  ] as const)(
    '%s uses the expected recoverable moderation action before resolving reports',
    async (action, moderationAction, reason, status, actionTaken) => {
      const transition = arrangeAction(status, actionTaken, { ban: action === 'ban' })

      const response = await POST(request(action))

      expect(response.status).toBe(200)
      expect(mockModerateCommentWithRollout).toHaveBeenCalledWith(
        expect.objectContaining({ from: expect.any(Function) }),
        {
          commentId: COMMENT_ID,
          actorId: 'admin-1',
          action: moderationAction,
          reason,
        }
      )
      expect(transition.eq).toHaveBeenCalledWith('status', 'pending')
      expect(transition.eq).toHaveBeenCalledWith('content_type', 'comment')
      expect(transition.eq).toHaveBeenCalledWith('content_id', COMMENT_ID)
      expect(transition.update).toHaveBeenCalledWith(
        expect.objectContaining({ status, resolved_at: BANNED_AT })
      )
      expect(mockFrom).toHaveBeenCalledWith('admin_logs')
    }
  )

  it('records a warning with the schema-valid resolved status', async () => {
    const transition = arrangeAction('resolved', 'user_warned')
    mockAutoEscalate.mockResolvedValue({ id: 'strike-1' })

    const response = await POST(request('warn'))

    expect(response.status).toBe(200)
    expect(mockAutoEscalate).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Function) }),
      'author-1',
      `Reported comment (${COMMENT_ID})`,
      'admin-1'
    )
    expect(transition.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'resolved',
        resolved_by: 'admin-1',
        resolved_at: BANNED_AT,
        action_taken: 'user_warned',
      })
    )
  })

  it('does not mark reports complete after comment moderation fails', async () => {
    queue('content_reports', { data: REPORT_IDS.map((id) => ({ id })) })
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('database', '40P01', 'rpc')
    )

    const response = await POST(request('delete'))

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })

  it('maps a missing comment without completing its reports', async () => {
    queue('content_reports', { data: REPORT_IDS.map((id) => ({ id })) })
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('not_found', 'P0002', 'rpc')
    )

    const response = await POST(request('approve'))

    expect(response.status).toBe(404)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the report transition does not acknowledge every pending report', async () => {
    arrangeAction('resolved', 'content_deleted', {
      transition: { data: reportAck('resolved', 'content_deleted').slice(0, 1) },
    })

    const response = await POST(request('delete'))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })

  it('does not moderate content when the pending-report read fails', async () => {
    queue('content_reports', { error: { code: 'XX601' } })

    const response = await POST(request('delete'))

    expect(response.status).toBe(500)
    expect(mockModerateCommentWithRollout).not.toHaveBeenCalled()
  })
})
