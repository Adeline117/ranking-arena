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
    headers: Map<string, string>
    private body: unknown
    constructor(
      url: string,
      init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
    ) {
      this.url = url
      this.method = init.method ?? 'POST'
      this.body = init.body
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }
    async json() {
      return this.body
    }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

type QueryResult = { data?: unknown; error?: { code?: string; message?: string } | null }

const mockModerateCommentWithRollout = jest.fn()
const mockFrom = jest.fn()
const queues = new Map<string, Array<Record<string, unknown>>>()

function query(result: QueryResult = {}) {
  const resolved = {
    data: Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null,
    error: result.error ?? null,
  }
  const promise = Promise.resolve(resolved)
  const chain: Record<string, unknown> = {}
  for (const method of ['select', 'eq', 'update', 'insert']) {
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

jest.mock('@/lib/admin/auth', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
  verifyAdmin: jest.fn().mockResolvedValue({ id: 'admin-1', email: 'admin@example.com' }),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { NextRequest } from 'next/server'
import { CommentMutationRolloutError } from '@/lib/data/comment-mutation-rollout'
import { POST } from '../route'

const REPORT_ID = 'report-1'
const COMMENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'
const report = {
  id: REPORT_ID,
  status: 'pending',
  content_type: 'comment',
  content_id: COMMENT_ID,
}
const resolvedReport = { ...report, status: 'resolved' }

function request() {
  return new NextRequest(`http://localhost/api/admin/reports/${REPORT_ID}/resolve`, {
    method: 'POST',
    headers: { authorization: 'Bearer test' },
    body: { action: 'resolve', reason: 'confirmed abuse' },
  })
}

function runRequest() {
  return POST(request(), { params: Promise.resolve({ id: REPORT_ID }) })
}

function arrangeSuccessfulResolution() {
  const initial = queue('content_reports', { data: report })
  const update = queue('content_reports', { data: resolvedReport })
  queue('admin_logs', { data: null })
  return { initial, update }
}

describe('POST admin report resolution for comments', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    queues.clear()
    mockFrom.mockImplementation((table: string) => {
      const builder = queues.get(table)?.shift()
      if (!builder) throw new Error(`Unexpected query for ${table}`)
      return builder
    })
    mockModerateCommentWithRollout.mockResolvedValue({
      post_id: 'post-1',
      affected_count: 0,
      comment_count: 2,
    })
  })

  it('hard-deletes the reported comment and strictly binds the report update', async () => {
    const { update } = arrangeSuccessfulResolution()

    const response = await runRequest()

    expect(response.status).toBe(200)
    expect(mockModerateCommentWithRollout).toHaveBeenCalledWith(
      expect.objectContaining({ from: expect.any(Function) }),
      {
        commentId: COMMENT_ID,
        actorId: 'admin-1',
        action: 'hard_delete',
        reason: 'confirmed abuse',
      }
    )
    expect(update.eq).toHaveBeenCalledWith('id', REPORT_ID)
    expect(update.eq).toHaveBeenCalledWith('status', 'pending')
    expect(update.eq).toHaveBeenCalledWith('content_type', 'comment')
    expect(update.eq).toHaveBeenCalledWith('content_id', COMMENT_ID)
    expect(update.maybeSingle).toHaveBeenCalledTimes(1)
  })

  it('returns an error when deletion succeeds but the report update fails', async () => {
    queue('content_reports', { data: report })
    queue('content_reports', { error: { code: 'XX401' } })

    const response = await runRequest()

    expect(response.status).toBe(500)
    expect(mockModerateCommentWithRollout).toHaveBeenCalledTimes(1)
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })

  it('recovers when a successful deletion is retried after the first report update failed', async () => {
    mockModerateCommentWithRollout
      .mockResolvedValueOnce({ post_id: 'post-1', affected_count: 1, comment_count: 2 })
      .mockRejectedValueOnce(new CommentMutationRolloutError('not_found', 'P0002', 'rpc'))
    queue('content_reports', { data: report })
    queue('content_reports', { error: { code: 'XX404' } })
    queue('content_reports', { data: report })
    queue('content_reports', { data: report })
    queue('comments', { data: null })
    queue('content_reports', { data: resolvedReport })
    queue('admin_logs', { data: null })

    const firstResponse = await runRequest()
    const retryResponse = await runRequest()

    expect(firstResponse.status).toBe(500)
    expect(retryResponse.status).toBe(200)
    expect(mockModerateCommentWithRollout).toHaveBeenCalledTimes(2)
  })

  it('resolves an idempotent retry only after re-confirming report binding and row absence', async () => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('not_found', 'P0002', 'rpc')
    )
    queue('content_reports', { data: report })
    queue('content_reports', { data: report })
    queue('comments', { data: null })
    queue('content_reports', { data: resolvedReport })
    queue('admin_logs', { data: null })

    const response = await runRequest()

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledWith('comments')
    expect(mockFrom).toHaveBeenCalledWith('admin_logs')
  })

  it('never treats not_found as success while the bound comment still exists', async () => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('not_found', 'P0002', 'rpc')
    )
    queue('content_reports', { data: report })
    queue('content_reports', { data: report })
    queue('comments', { data: { id: COMMENT_ID } })

    const response = await runRequest()

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })

  it.each([
    ['already processed', { ...report, status: 'resolved' }],
    ['different comment', { ...report, content_id: 'another-comment' }],
    ['different content type', { ...report, content_type: 'post' }],
  ])('rejects the retry when the report is %s', async (_label, reboundReport) => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('not_found', 'P0002', 'rpc')
    )
    queue('content_reports', { data: report })
    queue('content_reports', { data: reboundReport })

    const response = await runRequest()

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalledWith('comments')
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })

  it('fails closed when the absence confirmation query fails', async () => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('not_found', 'P0002', 'rpc')
    )
    queue('content_reports', { data: report })
    queue('content_reports', { data: report })
    queue('comments', { error: { code: 'XX402' } })

    const response = await runRequest()

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalledWith('admin_logs')
  })

  it('does not run absence confirmation for other rollout failures', async () => {
    mockModerateCommentWithRollout.mockRejectedValue(
      new CommentMutationRolloutError('database', 'XX403', 'rpc')
    )
    queue('content_reports', { data: report })

    const response = await runRequest()

    expect(response.status).toBe(500)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })
})
