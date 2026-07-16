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
    headers: Headers
    method = 'GET'

    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Headers(opts?.headers)
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/features', () => ({ socialFeatureGuard: jest.fn(() => null) }))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn(async () => null),
  RateLimitPresets: { public: { requests: 100, window: 60 } },
}))
jest.mock('@/lib/logger', () => ({
  logger: { apiError: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

type QueryResult = {
  data?: unknown[] | null
  count?: number | null
  error: unknown
}

type QueryChain = Record<string, jest.Mock> & {
  then: Promise<QueryResult>['then']
}

function makeQuery(result: QueryResult): QueryChain {
  const chain = {} as QueryChain
  for (const method of ['select', 'is', 'in', 'order']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.range = jest.fn(async () => result)
  chain.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject)
  return chain
}

const mockFrom = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ from: mockFrom }),
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

function queueRequest(
  dataResult: QueryResult = { data: [], error: null },
  countResult: QueryResult = { count: 0, error: null }
) {
  const dataQuery = makeQuery(dataResult)
  const countQuery = makeQuery(countResult)
  mockFrom.mockReturnValueOnce(dataQuery).mockReturnValueOnce(countQuery)
  return { dataQuery, countQuery }
}

describe('GET /api/groups current discovery boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns only the freshly queried discoverable subset with current pagination', async () => {
    const activeGroup = {
      id: '10000000-0000-4000-8000-000000000001',
      name: 'Active',
      member_count: 4,
    }
    const { dataQuery, countQuery } = queueRequest(
      { data: [activeGroup], error: null },
      { count: 1, error: null }
    )

    const response = await GET(new NextRequest('http://localhost/api/groups'))
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toEqual({
      success: true,
      data: {
        groups: [activeGroup],
        pagination: { limit: 10, offset: 0, total: 1, has_more: false },
      },
    })
    for (const query of [dataQuery, countQuery]) {
      expect(query.is).toHaveBeenCalledWith('dissolved_at', null)
      expect(query.in).toHaveBeenCalledWith('visibility', ['open', 'apply'])
    }
    expect(dataQuery.order).toHaveBeenNthCalledWith(1, 'member_count', {
      ascending: false,
      nullsFirst: false,
    })
    expect(dataQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true })
  })

  it('does not serve a group after a later request observes dissolution/deletion', async () => {
    queueRequest(
      {
        data: [{ id: '10000000-0000-4000-8000-000000000001', name: 'Before' }],
        error: null,
      },
      { count: 1, error: null }
    )
    queueRequest({ data: [], error: null }, { count: 0, error: null })

    const first = await GET(new NextRequest('http://localhost/api/groups'))
    const second = await GET(new NextRequest('http://localhost/api/groups'))

    expect((await first.json()).data.groups).toHaveLength(1)
    expect((await second.json()).data).toEqual({
      groups: [],
      pagination: { limit: 10, offset: 0, total: 0, has_more: false },
    })
    expect(mockFrom).toHaveBeenCalledTimes(4)
  })

  it('honors bounded pagination and allow-listed sorting', async () => {
    const { dataQuery } = queueRequest({ data: [], error: null }, { count: 80, error: null })

    const response = await GET(
      new NextRequest('http://localhost/api/groups?limit=100&offset=20&sort_by=activity')
    )
    const body = await response.json()

    expect(body.data.pagination).toEqual({ limit: 50, offset: 20, total: 80, has_more: true })
    expect(dataQuery.order).toHaveBeenNthCalledWith(1, 'updated_at', {
      ascending: false,
      nullsFirst: false,
    })
    expect(dataQuery.range).toHaveBeenCalledWith(20, 69)
  })

  it('defaults an unrecognized sort token instead of creating an arbitrary query surface', async () => {
    const { dataQuery } = queueRequest()

    await GET(new NextRequest('http://localhost/api/groups?sort_by=secret_column'))

    expect(dataQuery.order).toHaveBeenNthCalledWith(1, 'member_count', {
      ascending: false,
      nullsFirst: false,
    })
  })

  it.each([
    ['data', { data: null, error: new Error('data failed') }, { count: 0, error: null }],
    ['count', { data: [], error: null }, { count: null, error: new Error('count failed') }],
  ])('fails closed when the %s query fails', async (_label, dataResult, countResult) => {
    queueRequest(dataResult, countResult)

    const response = await GET(new NextRequest('http://localhost/api/groups'))
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body).toEqual({ success: false, error: 'Internal server error' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
  })

  it('marks successful discovery responses private/no-store at every cache layer', async () => {
    queueRequest()

    const response = await GET(new NextRequest('http://localhost/api/groups'))

    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
  })

  it('contains no final-payload cache path', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/groups/route.ts'), 'utf8')
    expect(source).not.toContain("from '@/lib/cache'")
    expect(source).not.toContain('getOrSetWithLock')
    expect(source).not.toContain('s-maxage')
  })
})
