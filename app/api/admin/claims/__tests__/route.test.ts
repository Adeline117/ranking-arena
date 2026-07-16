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
    method = 'GET'
    constructor(url: string) {
      this.url = url
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

type QueryResult = {
  data?: unknown
  count?: number | null
  error?: { message: string } | null
}

const mockFrom = jest.fn()

function query(result: QueryResult = {}) {
  const resolved = {
    data: Object.prototype.hasOwnProperty.call(result, 'data') ? result.data : null,
    count: result.count ?? null,
    error: result.error ?? null,
  }
  const promise = Promise.resolve(resolved)
  const chain: Record<string, jest.Mock | typeof promise.then> = {}
  for (const method of ['select', 'eq', 'in', 'order', 'range']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.then = promise.then.bind(promise)
  return chain as Record<string, jest.Mock> & PromiseLike<typeof resolved>
}

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

import { NextRequest } from 'next/server'
import { GET } from '../route'

function claim(index: number, status = 'verified') {
  return {
    id: `claim-${String(index).padStart(3, '0')}`,
    user_id: `user-${index}`,
    trader_id: `trader-${index}`,
    source: 'binance',
    handle: null,
    verification_method: 'api_key',
    verification_data: null,
    status,
    reject_reason: null,
    reviewed_by: null,
    reviewed_at: null,
    verified_at: null,
    created_at: '2026-07-16T10:00:00.000Z',
    updated_at: '2026-07-16T10:00:00.000Z',
  }
}

function arrange(claims: ReturnType<typeof claim>[], count: number, error?: { message: string }) {
  const claimsQuery = query({ data: claims, count, error })
  const profilesQuery = query({
    data: claims.map((item) => ({
      id: item.user_id,
      email: `${item.user_id}@example.com`,
      handle: null,
    })),
  })
  mockFrom.mockImplementation((table: string) => {
    if (table === 'trader_claims') return claimsQuery
    if (table === 'user_profiles') return profilesQuery
    throw new Error(`Unexpected table ${table}`)
  })
  return { claimsQuery, profilesQuery }
}

async function request(queryString = '') {
  const response = await GET(new NextRequest(`http://localhost/api/admin/claims${queryString}`))
  return { response, body: await response.json() }
}

describe('GET /api/admin/claims pagination', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns a real total and has_more instead of treating page length as total', async () => {
    const rows = Array.from({ length: 200 }, (_, index) => claim(index))
    const { claimsQuery } = arrange(rows, 201)

    const { response, body } = await request()

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      total: 201,
      limit: 200,
      offset: 0,
      has_more: true,
      status: 'all',
    })
    expect(body.data.claims).toHaveLength(200)
    expect(claimsQuery.select).toHaveBeenCalledWith(expect.any(String), { count: 'exact' })
    expect(claimsQuery.range).toHaveBeenCalledWith(0, 199)
  })

  it('can retrieve the record after the first 200 rows', async () => {
    const { claimsQuery } = arrange([claim(200)], 201)

    const { body } = await request('?offset=200')

    expect(body.data.claims).toHaveLength(1)
    expect(body.data).toMatchObject({ total: 201, offset: 200, has_more: false })
    expect(claimsQuery.range).toHaveBeenCalledWith(200, 399)
  })

  it('filters reviewable claims before paging and orders the oldest first', async () => {
    const { claimsQuery } = arrange([claim(1, 'pending'), claim(2, 'reviewing')], 2)

    const { body } = await request('?status=reviewable&limit=50')

    expect(body.data.status).toBe('reviewable')
    expect(claimsQuery.in).toHaveBeenCalledWith('status', ['pending', 'reviewing'])
    expect(claimsQuery.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: true })
    expect(claimsQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: true })
    expect(claimsQuery.range).toHaveBeenCalledWith(0, 49)
  })

  it.each(['verified', 'rejected', 'all'])(
    'orders %s history newest first with a stable id tie-breaker',
    async (status) => {
      const { claimsQuery } = arrange([claim(1, status)], 1)

      await request(`?status=${status}`)

      if (status === 'all') expect(claimsQuery.eq).not.toHaveBeenCalled()
      else expect(claimsQuery.eq).toHaveBeenCalledWith('status', status)
      expect(claimsQuery.order).toHaveBeenNthCalledWith(1, 'created_at', { ascending: false })
      expect(claimsQuery.order).toHaveBeenNthCalledWith(2, 'id', { ascending: false })
    }
  )

  it('clamps an excessive limit to 200', async () => {
    const { claimsQuery } = arrange([], 0)

    const { body } = await request('?limit=999')

    expect(body.data.limit).toBe(200)
    expect(claimsQuery.range).toHaveBeenCalledWith(0, 199)
  })

  it('rejects an unknown status without querying the database', async () => {
    const { response, body } = await request('?status=unknown')

    expect(response.status).toBe(400)
    expect(body.error).toBe('Invalid claim status filter')
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns a database failure without attempting profile enrichment', async () => {
    const { profilesQuery } = arrange([], 0, { message: 'claims unavailable' })

    const { response, body } = await request('?status=reviewable')

    expect(response.status).toBe(500)
    expect(body.error).toBe('claims unavailable')
    expect(profilesQuery.select).not.toHaveBeenCalled()
  })
})
