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
    constructor(url: string, init: { method?: string } = {}) {
      this.url = url
      this.method = init.method ?? 'POST'
    }
  }
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockFrom = jest.fn()
const mockModerateCommentHardDeleteWithRollout = jest.fn()

function rowQuery(data: unknown, error: { code?: string; message?: string } | null = null) {
  const chain: Record<string, jest.Mock> = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue({ data, error }),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return chain
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: { id: string }
        supabase: { from: typeof mockFrom }
        request: unknown
      }) => unknown
    ) =>
    async (request: unknown) => {
      try {
        return await handler({
          user: { id: 'group-admin' },
          supabase: { from: (...args: unknown[]) => mockFrom(...args) },
          request,
        })
      } catch (error: unknown) {
        return {
          status: (error as { statusCode?: number })?.statusCode ?? 500,
          _body: { error: 'Internal server error' },
          async json() {
            return this._body
          },
          headers: new Map(),
        }
      }
    },
}))

jest.mock('@/lib/data/comment-mutation-rollout', () => ({
  CommentMutationRolloutError: class CommentMutationRolloutError extends Error {},
  moderateCommentHardDeleteWithRollout: (...args: unknown[]) =>
    mockModerateCommentHardDeleteWithRollout(...args),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => null }))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const GROUP_ID = 'group-1'
const COMMENT_ID = '4d2a4fa2-bf19-4ab4-a740-04ebaa9d636b'

function request() {
  return new NextRequest(`http://localhost/api/groups/${GROUP_ID}/comments/${COMMENT_ID}/delete`, {
    method: 'POST',
  })
}

function context() {
  return { params: Promise.resolve({ id: GROUP_ID, commentId: COMMENT_ID }) }
}

describe('POST group comment delete', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockImplementation((table: string) => {
      if (table === 'group_members') return rowQuery({ role: 'admin' })
      if (table === 'comments') return rowQuery({ id: COMMENT_ID, post_id: 'post-1' })
      if (table === 'posts') return rowQuery({ group_id: GROUP_ID })
      throw new Error(`Unexpected table: ${table}`)
    })
    mockModerateCommentHardDeleteWithRollout.mockResolvedValue({
      post_id: 'post-1',
      affected_count: 2,
      comment_count: 4,
    })
  })

  it('retains group role checks and hard-deletes through the rollout bridge', async () => {
    const response = await POST(request(), context())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockModerateCommentHardDeleteWithRollout).toHaveBeenCalledWith(expect.anything(), {
      commentId: COMMENT_ID,
      expectedPostId: 'post-1',
      actorId: 'group-admin',
      reason: 'Deleted by group administrator',
    })
    expect(body).toEqual({ success: true, affected_count: 2, comment_count: 4 })
  })

  it('rejects a member without an administrative role', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'group_members') return rowQuery({ role: 'member' })
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await POST(request(), context())

    expect(response.status).toBe(403)
    expect(mockModerateCommentHardDeleteWithRollout).not.toHaveBeenCalled()
  })

  it.each([
    ['membership lookup', 'group_members'],
    ['comment lookup', 'comments'],
    ['post lookup', 'posts'],
  ])('fails closed on a %s error', async (_label, failedTable) => {
    mockFrom.mockImplementation((table: string) => {
      if (table === failedTable) return rowQuery(null, { code: 'XX001', message: 'failed' })
      if (table === 'group_members') return rowQuery({ role: 'admin' })
      if (table === 'comments') return rowQuery({ id: COMMENT_ID, post_id: 'post-1' })
      if (table === 'posts') return rowQuery({ group_id: GROUP_ID })
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
    expect(mockModerateCommentHardDeleteWithRollout).not.toHaveBeenCalled()
  })

  it('rejects a missing comment', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'group_members') return rowQuery({ role: 'admin' })
      if (table === 'comments') return rowQuery(null)
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await POST(request(), context())

    expect(response.status).toBe(404)
    expect(mockModerateCommentHardDeleteWithRollout).not.toHaveBeenCalled()
  })

  it('rejects a comment whose post is outside the group', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'group_members') return rowQuery({ role: 'admin' })
      if (table === 'comments') return rowQuery({ id: COMMENT_ID, post_id: 'post-1' })
      if (table === 'posts') return rowQuery({ group_id: 'another-group' })
      throw new Error(`Unexpected table: ${table}`)
    })

    const response = await POST(request(), context())

    expect(response.status).toBe(400)
    expect(mockModerateCommentHardDeleteWithRollout).not.toHaveBeenCalled()
  })

  it('returns non-2xx when the validated bridge fails', async () => {
    mockModerateCommentHardDeleteWithRollout.mockRejectedValue(new Error('failed'))

    const response = await POST(request(), context())

    expect(response.status).toBe(500)
  })
})
