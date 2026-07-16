jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    constructor(body?: unknown, init: any = {}) {
      this._body = body
      this.status = init.status || 200
    }
    async json() {
      return this._body
    }
    static json(data: unknown, init?: any) {
      return new MockNextResponse(data, init)
    }
  }
  class MockNextRequest {
    url: string
    nextUrl: any
    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
    }
  }
  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

const mockCacheGet = jest.fn()

jest.mock('@/lib/cache', () => ({
  get: (...args: unknown[]) => mockCacheGet(...args),
  set: jest.fn(),
}))

// Build a proxy-based chain so ANY method can be chained, and .limit() resolves
function makeChainMock(terminalResult = { data: [], error: null }) {
  const chain: Record<string, jest.Mock> = {}
  const proxy: Record<string, jest.Mock> = new Proxy(chain, {
    get(target, prop) {
      if (prop === 'then') {
        return (
          resolve: (value: typeof terminalResult) => unknown,
          reject: (reason: unknown) => unknown
        ) => Promise.resolve(terminalResult).then(resolve, reject)
      }
      if (!target[prop as string]) {
        // Terminal methods that resolve
        if (['limit', 'single', 'maybeSingle', 'insert'].includes(prop as string)) {
          target[prop as string] = jest.fn().mockResolvedValue(terminalResult)
        } else {
          target[prop as string] = jest.fn().mockReturnValue(proxy)
        }
      }
      return target[prop as string]
    },
  }) as Record<string, jest.Mock>
  return proxy
}

const mockFrom = jest.fn(() => makeChainMock())
const mockRpc = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: any) => {
    return async (req: any) => {
      return handler({ supabase: { from: mockFrom, rpc: mockRpc }, request: req })
    }
  },
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: any) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json(data)
  }, // eslint-disable-line @typescript-eslint/no-require-imports
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/search', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCacheGet.mockResolvedValue(null)
    mockFrom.mockImplementation(() => makeChainMock())
    mockRpc.mockResolvedValue({ data: true, error: null })
  })

  it('returns empty results for missing query', async () => {
    const req = new NextRequest('http://localhost/api/search')
    const res = await GET(req)
    const body = await res.json()
    expect(body.total).toBe(0)
    expect(body.results.traders).toEqual([])
  })

  it('returns empty results for empty query', async () => {
    const req = new NextRequest('http://localhost/api/search?q=')
    const res = await GET(req)
    const body = await res.json()
    expect(body.total).toBe(0)
  })

  it('performs search with valid query', async () => {
    const req = new NextRequest('http://localhost/api/search?q=bitcoin&limit=3')
    const res = await GET(req)
    const body = await res.json()
    expect(body).toBeDefined()
  })

  it('does not derive hot keywords from an audience-denied post', async () => {
    mockFrom.mockImplementation(() =>
      makeChainMock({
        data: [
          {
            id: 'private-post',
            title: 'PRIVATE_ALPHA',
            hot_score: 100,
            view_count: 100,
            like_count: 10,
            comment_count: 10,
          },
        ],
        error: null,
      })
    )
    mockRpc.mockResolvedValue({ data: false, error: null })

    const req = new NextRequest('http://localhost/api/search?type=hot')
    const res = await GET(req)
    const body = await res.json()

    expect(body.hotSearches).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ keyword: 'PRIVATE_ALPHA' })])
    )
    expect(mockRpc).toHaveBeenCalledWith('can_service_actor_read_post', {
      p_post_id: 'private-post',
      p_actor_id: null,
    })
  })

  it('re-authorizes cached unified results and suggestions before returning them', async () => {
    mockCacheGet.mockResolvedValue({
      result: {
        query: 'private',
        results: {
          traders: [],
          posts: [
            {
              id: 'private-post',
              type: 'post',
              title: 'Private result',
              href: '/post/private-post',
            },
          ],
          users: [],
          groups: [],
        },
        total: 1,
      },
      suggestionCandidates: {
        traders: [],
        posts: [{ id: 'private-post', title: 'Private suggestion' }],
        groups: [],
      },
    })
    mockRpc.mockResolvedValue({ data: false, error: null })

    const req = new NextRequest('http://localhost/api/search?q=private')
    const res = await GET(req)
    const body = await res.json()

    expect(body.results.posts).toEqual([])
    expect(body.suggestions).toBeUndefined()
    expect(body.total).toBe(0)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it('fails closed for cached groups and users that are no longer public', async () => {
    mockCacheGet.mockResolvedValue({
      result: {
        query: 'stale',
        results: {
          traders: [],
          posts: [],
          users: [{ id: 'deleted-user', type: 'user', title: '@gone', href: '/u/gone' }],
          groups: [{ id: 'dissolved-group', type: 'group', title: 'Gone', href: '/groups/gone' }],
        },
        total: 2,
      },
      suggestionCandidates: {
        traders: [],
        posts: [],
        groups: [{ id: 'dissolved-group', name: 'Gone group' }],
      },
    })
    mockFrom.mockImplementation(() => makeChainMock({ data: [], error: null }))

    const req = new NextRequest('http://localhost/api/search?q=stale')
    const res = await GET(req)
    const body = await res.json()

    expect(body.results.users).toEqual([])
    expect(body.results.groups).toEqual([])
    expect(body.suggestions).toBeUndefined()
    expect(body.total).toBe(0)
  })
})
