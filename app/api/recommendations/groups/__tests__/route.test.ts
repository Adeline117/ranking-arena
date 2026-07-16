import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers = new Headers()
    method = 'GET'

    constructor(url: string) {
      this.url = url
      this.nextUrl = new URL(url)
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

type QueryResult = { data: unknown[] | null; error: unknown }
type QueryChain = Record<string, jest.Mock> & { then: Promise<QueryResult>['then'] }

function makeQuery(result: QueryResult): QueryChain {
  const chain = {} as QueryChain
  for (const method of ['select', 'in', 'is', 'order']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.limit = jest.fn(async () => result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockGetAuthUser = jest.fn()
const mockHandleError = jest.fn((error: unknown) => {
  const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
  return NextResponse.json(
    { success: false, error: error instanceof Error ? error.message : String(error) },
    { status: 500 }
  )
})

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom, rpc: mockRpc }),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  success: (data: unknown, status = 200, headers?: Record<string, string>) => {
    const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
    return NextResponse.json({ success: true, data }, { status, headers })
  },
  handleError: (...args: unknown[]) => mockHandleError(...args),
  validateNumber: (value: unknown, options: { min: number; max: number }) => {
    if (value === null || value === undefined || value === '') return null
    const parsed = Number(value)
    if (!Number.isFinite(parsed)) return null
    return Math.min(options.max, Math.max(options.min, parsed))
  },
  checkRateLimit: jest.fn(async () => null),
  RateLimitPresets: { public: { requests: 100, window: 60 } },
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: jest.fn(() => null) }))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/recommendations/groups current audience boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockRpc.mockResolvedValue({ data: [], error: null })
  })

  it('reads anonymous recommendations from the current discoverable subset', async () => {
    const group = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Current',
      description: 'Current description',
      member_count: 8,
    }
    const query = makeQuery({ data: [group], error: null })
    mockFrom.mockReturnValueOnce(query)

    const response = await GET(
      new NextRequest('http://localhost/api/recommendations/groups?limit=8')
    )
    const body = await response.json()

    expect(body).toEqual({
      success: true,
      data: { groups: [group], personalized: false },
    })
    expect(query.is).toHaveBeenCalledWith('dissolved_at', null)
    expect(query.in).toHaveBeenCalledWith('visibility', ['open', 'apply'])
    expect(query.order).toHaveBeenNthCalledWith(1, 'member_count', {
      ascending: false,
      nullsFirst: false,
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('does not replay an anonymous group after its current row disappears', async () => {
    mockFrom
      .mockReturnValueOnce(
        makeQuery({
          data: [{ id: '10000000-0000-4000-8000-000000000001', name: 'Before' }],
          error: null,
        })
      )
      .mockReturnValueOnce(makeQuery({ data: [], error: null }))

    const first = await GET(new NextRequest('http://localhost/api/recommendations/groups'))
    const second = await GET(new NextRequest('http://localhost/api/recommendations/groups'))

    expect((await first.json()).data.groups).toHaveLength(1)
    expect((await second.json()).data.groups).toEqual([])
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('treats personalized RPC rows as candidates and drops non-current groups', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '20000000-0000-4000-8000-000000000001' })
    mockRpc.mockResolvedValue({
      data: [
        {
          group_id: '10000000-0000-4000-8000-000000000001',
          reason: 'members_overlap',
          score: 10,
        },
        {
          group_id: '10000000-0000-4000-8000-000000000002',
          reason: 'stale',
          score: 9,
        },
      ],
      error: null,
    })
    const currentQuery = makeQuery({
      data: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          name: 'Current',
          member_count: 3,
        },
      ],
      error: null,
    })
    mockFrom.mockReturnValueOnce(currentQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/recommendations/groups?limit=1')
    )
    const body = await response.json()

    expect(mockRpc).toHaveBeenCalledWith('recommend_groups_for_user', {
      p_user_id: '20000000-0000-4000-8000-000000000001',
      p_limit: 1,
    })
    expect(currentQuery.in).toHaveBeenNthCalledWith(1, 'id', [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
    ])
    expect(currentQuery.is).toHaveBeenCalledWith('dissolved_at', null)
    expect(currentQuery.in).toHaveBeenNthCalledWith(2, 'visibility', ['open', 'apply'])
    expect(body.data).toEqual({
      groups: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          name: 'Current',
          member_count: 3,
          recommendation_reason: 'members_overlap',
          recommendation_score: 10,
        },
      ],
      personalized: true,
    })
  })

  it('pads a failed personalized ranking only with current discoverable groups', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '20000000-0000-4000-8000-000000000001' })
    mockRpc.mockResolvedValue({ data: null, error: new Error('ranking unavailable') })
    const popularQuery = makeQuery({
      data: [{ id: '10000000-0000-4000-8000-000000000003', name: 'Popular' }],
      error: null,
    })
    mockFrom.mockReturnValueOnce(popularQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/recommendations/groups?limit=2')
    )
    const body = await response.json()

    expect(popularQuery.is).toHaveBeenCalledWith('dissolved_at', null)
    expect(popularQuery.in).toHaveBeenCalledWith('visibility', ['open', 'apply'])
    expect(body.data.groups).toEqual([
      {
        id: '10000000-0000-4000-8000-000000000003',
        name: 'Popular',
        recommendation_reason: 'popular',
      },
    ])
  })

  it('fails closed and marks the error no-store when the current-state read fails', async () => {
    mockFrom.mockReturnValueOnce(makeQuery({ data: null, error: new Error('groups failed') }))

    const response = await GET(new NextRequest('http://localhost/api/recommendations/groups'))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ success: false, error: 'groups failed' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('contains no materialized-group cache path', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/recommendations/groups/route.ts'),
      'utf8'
    )
    expect(source).not.toContain('@/lib/cache/redis-layer')
    expect(source).not.toContain('tieredGetOrSet')
    expect(source).not.toContain('s-maxage')
    expect(source.match(/\.is\('dissolved_at', null\)/g)).toHaveLength(3)
    expect(source.match(/\.in\('visibility'/g)).toHaveLength(3)
  })
})
