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
const mockFrom = jest.fn()

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

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => async (request: unknown) =>
    handler({
      user: { id: 'reporter-4' },
      supabase: { from: mockFrom },
      request,
    }),
}))

jest.mock('@/lib/api/response', () => {
  const response = (body: unknown, status = 200) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json(body, { status })
  }
  return {
    badRequest: (message: string) => response({ error: message }, 400),
    conflict: (message: string) => response({ error: message }, 409),
    serverError: (message: string) => response({ error: message }, 500),
    success: (data: unknown) => response({ success: true, data }),
  }
})

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { CommentMutationRolloutError } from '@/lib/data/comment-mutation-rollout'
import { POST } from '../route'

const COMMENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'
const REPORTERS = ['reporter-1', 'reporter-2', 'reporter-3', 'reporter-4']
let pendingReportError: { code: string } | null
let reporterIds: string[]

function chain(result: { data?: unknown; error?: unknown }) {
  const query: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'in']) {
    query[method] = jest.fn(() => query)
  }
  query.maybeSingle = jest.fn().mockResolvedValue(result)
  query.insert = jest.fn().mockResolvedValue(result)
  query.then = (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve)
  return query
}

function request() {
  return new NextRequest('http://localhost/api/report', {
    method: 'POST',
    body: {
      content_type: 'comment',
      content_id: COMMENT_ID,
      reason: 'harassment',
      description: 'abuse',
    },
  })
}

describe('POST /api/report comment auto-hide', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    reporterIds = [...REPORTERS]
    pendingReportError = null
    let contentReportQuery = 0
    mockFrom.mockImplementation((table: string) => {
      if (table === 'content_reports') {
        contentReportQuery += 1
        if (contentReportQuery === 1) return chain({ data: null, error: null })
        if (contentReportQuery === 2) return chain({ error: null })
        return chain({
          data: reporterIds.map((reporter_id) => ({ reporter_id })),
          error: pendingReportError,
        })
      }
      if (table === 'user_profiles') {
        return chain({
          data: reporterIds.map((id) => ({
            id,
            created_at: '2020-01-01T00:00:00.000Z',
            reputation_score: 10,
          })),
          error: null,
        })
      }
      throw new Error(`Unexpected table: ${table}`)
    })
    mockModerateCommentWithRollout.mockResolvedValue({
      post_id: 'post-1',
      affected_count: 1,
      comment_count: 7,
    })
  })

  it('soft-deletes a thresholded comment as a system actor with an audit reason', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: { ok: true, moderation_status: 'applied' },
    })
    expect(mockModerateCommentWithRollout).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Function) }),
      {
        commentId: COMMENT_ID,
        actorId: null,
        action: 'soft_delete',
        reason: 'Auto-hidden: weighted report score 4.0 (4 reporters)',
      }
    )
  })

  it('keeps the saved report and marks moderation pending when the bridge fails', async () => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('database', '40P01', 'rpc')
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: { ok: true, moderation_status: 'pending' },
    })
  })

  it('marks moderation pending when the weighted-report source cannot be trusted', async () => {
    pendingReportError = { code: 'XX501' }

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.moderation_status).toBe('pending')
    expect(mockModerateCommentWithRollout).not.toHaveBeenCalled()
  })

  it('does not moderate below the weighted threshold', async () => {
    reporterIds = REPORTERS.slice(0, 3)

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data.moderation_status).toBe('not_required')
    expect(mockModerateCommentWithRollout).not.toHaveBeenCalled()
  })
})
