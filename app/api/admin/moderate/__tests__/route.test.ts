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

const mockModerateCommentWithRollout = jest.fn()
const mockInsert = jest.fn().mockResolvedValue({ error: null })
const mockFrom = jest.fn(() => ({ insert: mockInsert }))

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

import { NextRequest } from 'next/server'
import { CommentMutationRolloutError } from '@/lib/data/comment-mutation-rollout'
import { POST } from '../route'

const COMMENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'

function request(reason = 'reported abuse') {
  return new NextRequest('http://localhost/api/admin/moderate', {
    method: 'POST',
    body: { action: 'delete_comment', targetId: COMMENT_ID, reason },
  })
}

describe('POST /api/admin/moderate comment deletion', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockModerateCommentWithRollout.mockResolvedValue({
      post_id: 'post-1',
      affected_count: 2,
      comment_count: 3,
    })
  })

  it('hard-deletes the comment through the rollout bridge with actor and reason', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockModerateCommentWithRollout).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Function) }),
      {
        commentId: COMMENT_ID,
        actorId: 'admin-1',
        action: 'hard_delete',
        reason: 'reported abuse',
      }
    )
    expect(mockFrom).toHaveBeenCalledWith('admin_logs')
  })

  it.each([
    ['not_found', 404],
    ['database', 500],
    ['conflict', 500],
  ])('maps a %s rollout failure without writing an audit success', async (kind, status) => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError(kind as 'not_found' | 'database' | 'conflict')
    )

    const response = await POST(request())

    expect(response.status).toBe(status)
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })
})
