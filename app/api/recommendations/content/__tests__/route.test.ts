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
const mockTieredGetOrSet = jest.fn()
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
  validateEnum: (value: unknown, allowed: readonly string[]) =>
    typeof value === 'string' && allowed.includes(value) ? value : null,
  checkRateLimit: jest.fn(async () => null),
  RateLimitPresets: { public: { requests: 100, window: 60 } },
}))

jest.mock('@/lib/cache/redis-layer', () => ({
  tieredGetOrSet: (...args: unknown[]) => mockTieredGetOrSet(...args),
}))

jest.mock('@/lib/data/service-post-audience', () => ({
  filterServiceReadablePostRows: jest.fn(async (_client, rows: unknown[]) => rows),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/recommendations/content group discovery boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(null)
    mockRpc.mockResolvedValue({ data: [], error: null })
  })

  it('serves anonymous group recommendations from current groups, never the post cache', async () => {
    const group = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Current group',
      member_count: 8,
    }
    const popularQuery = makeQuery({ data: [group], error: null })
    mockFrom.mockReturnValueOnce(popularQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/recommendations/content?type=group&limit=1')
    )
    const body = await response.json()

    expect(mockTieredGetOrSet).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
    expect(popularQuery.is).toHaveBeenCalledWith('dissolved_at', null)
    expect(popularQuery.in).toHaveBeenCalledWith('visibility', ['open', 'apply'])
    expect(body).toEqual({
      success: true,
      data: {
        recommendations: [{ ...group, recommendation_reason: 'popular' }],
        type: 'group',
        personalized: false,
      },
    })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('materializes authenticated ranking IDs against current discoverability', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '20000000-0000-4000-8000-000000000001' })
    mockRpc.mockResolvedValue({
      data: [
        {
          group_id: '10000000-0000-4000-8000-000000000001',
          group_name: 'Stale RPC name',
          reason: 'members_overlap',
          score: 5,
        },
        {
          group_id: '10000000-0000-4000-8000-000000000002',
          group_name: 'Dissolved RPC name',
          reason: 'stale',
          score: 4,
        },
      ],
      error: null,
    })
    const currentQuery = makeQuery({
      data: [
        {
          id: '10000000-0000-4000-8000-000000000001',
          name: 'Current DB name',
          member_count: 3,
        },
      ],
      error: null,
    })
    mockFrom.mockReturnValueOnce(currentQuery)

    const response = await GET(
      new NextRequest('http://localhost/api/recommendations/content?type=group&limit=1')
    )
    const body = await response.json()

    expect(mockRpc).toHaveBeenCalledWith('recommend_groups_for_user', {
      p_user_id: '20000000-0000-4000-8000-000000000001',
      p_limit: 1,
    })
    expect(currentQuery.in).toHaveBeenNthCalledWith(1, 'id', [
      '10000000-0000-4000-8000-000000000001',
    ])
    expect(currentQuery.is).toHaveBeenCalledWith('dissolved_at', null)
    expect(currentQuery.in).toHaveBeenNthCalledWith(2, 'visibility', ['open', 'apply'])
    expect(body.data.recommendations).toEqual([
      {
        id: '10000000-0000-4000-8000-000000000001',
        name: 'Current DB name',
        member_count: 3,
        recommendation_reason: 'members_overlap',
        recommendation_score: 5,
      },
    ])
    expect(JSON.stringify(body)).not.toContain('Stale RPC name')
    expect(JSON.stringify(body)).not.toContain('Dissolved RPC name')
  })

  it('fails closed with no-store headers when the current group read fails', async () => {
    mockFrom.mockReturnValueOnce(
      makeQuery({ data: null, error: new Error('current groups unavailable') })
    )

    const response = await GET(
      new NextRequest('http://localhost/api/recommendations/content?type=group&limit=1')
    )
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ success: false, error: 'current groups unavailable' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })
})
