jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetOrSetWithLock = jest.fn()

jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

const mockRpc = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: (context: unknown) => unknown) => () =>
    handler({ supabase: { rpc: mockRpc, from: mockFrom } }),
}))

function makeQuery(result: { data: unknown[]; error: unknown }) {
  const proxy = new Proxy<Record<string, unknown>>(
    {},
    {
      get(_target, property) {
        if (property === 'then') {
          return (
            resolve: (value: typeof result) => unknown,
            reject: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject)
        }
        return jest.fn(() => proxy)
      },
    }
  )
  return proxy
}

import { GET } from '../route'

describe('GET /api/sidebar/trending', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockImplementation(() => makeQuery({ data: [], error: null }))
  })

  it('re-authorizes cached candidates and prevents final CDN caching', async () => {
    mockGetOrSetWithLock.mockResolvedValue([
      {
        id: 'readable-post',
        title: 'Readable',
        content: null,
        author_handle: 'reader',
        comment_count: 1,
        like_count: 1,
        view_count: 1,
        hot_score: 1,
        created_at: '2026-07-16T00:00:00.000Z',
        group_id: null,
      },
      {
        id: 'private-post',
        title: 'Private',
        content: 'secret',
        author_handle: 'private',
        comment_count: 99,
        like_count: 99,
        view_count: 99,
        hot_score: 99,
        created_at: '2026-07-16T00:00:00.000Z',
        group_id: null,
      },
    ])
    mockRpc.mockImplementation(async (_name: string, params: { p_post_id: string }) => ({
      data: params.p_post_id === 'readable-post',
      error: null,
    }))

    const response = await GET()
    const body = await response.json()

    expect(body.posts.map((post: { id: string }) => post.id)).toEqual(['readable-post'])
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(mockGetOrSetWithLock).toHaveBeenCalledWith(
      'sidebar:trending-discussions:v2:candidates',
      expect.any(Function),
      { ttl: 180, lockTtl: 10 }
    )
  })

  it('fails closed for a group post after the group is dissolved', async () => {
    mockGetOrSetWithLock.mockResolvedValue([
      {
        id: 'dissolved-post',
        title: 'Gone',
        content: null,
        author_handle: 'gone',
        comment_count: 1,
        like_count: 1,
        view_count: 1,
        hot_score: 1,
        created_at: '2026-07-16T00:00:00.000Z',
        group_id: 'dissolved-group',
      },
    ])
    mockRpc.mockResolvedValue({ data: true, error: null })
    mockFrom.mockImplementation(() => makeQuery({ data: [], error: null }))

    const response = await GET()
    const body = await response.json()

    expect(body.posts).toEqual([])
  })
})
