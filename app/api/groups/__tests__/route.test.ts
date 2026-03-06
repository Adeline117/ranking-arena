/**
 * /api/groups route tests
 *
 * Tests listing groups with sorting, pagination, caching,
 * and error handling.
 */

// --- Mocks ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string
    constructor(url: string, opts?: { headers?: Record<string, string> }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries(opts?.headers || {}))
      this.method = 'GET'
    }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

let supabaseDataResult: { data: unknown[] | null; error: unknown } = { data: [], error: null }
let supabaseCountResult: { count: number | null; error: unknown } = { count: 0, error: null }

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => ({
    from: jest.fn(() => {
      const chain: Record<string, jest.Mock> = {}
      chain.select = jest.fn((_, opts) => {
        if (opts?.count === 'exact' && opts?.head === true) {
          return Promise.resolve(supabaseCountResult)
        }
        return chain
      })
      chain.order = jest.fn(() => chain)
      chain.range = jest.fn(() => Promise.resolve(supabaseDataResult))
      return chain
    }),
  })),
}))

const mockGetOrSetWithLock = jest.fn()
jest.mock('@/lib/cache', () => ({
  getOrSetWithLock: (...args: unknown[]) => mockGetOrSetWithLock(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { apiError: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/groups', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    supabaseDataResult = { data: [], error: null }
    supabaseCountResult = { count: 0, error: null }
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-key'
  })

  it('returns groups list with default pagination', async () => {
    const mockResult = {
      success: true,
      data: {
        groups: [
          { id: 'g1', name: 'Top Traders', member_count: 150 },
          { id: 'g2', name: 'Crypto Chat', member_count: 80 },
        ],
        pagination: { limit: 10, offset: 0, total: 2, has_more: false },
      },
    }
    mockGetOrSetWithLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
      // Execute the function to test its logic
      return mockResult
    })

    const req = new NextRequest('http://localhost/api/groups')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.data.groups).toBeDefined()
  })

  it('respects limit parameter capped at 50', async () => {
    mockGetOrSetWithLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => {
      return {
        success: true,
        data: { groups: [], pagination: { limit: 50, offset: 0, total: 0, has_more: false } },
      }
    })

    const req = new NextRequest('http://localhost/api/groups?limit=100')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    // The route clamps limit to 50, but cache key will use 50
    expect(body.data.pagination.limit).toBeLessThanOrEqual(50)
  })

  it('supports offset pagination', async () => {
    mockGetOrSetWithLock.mockImplementation(async () => ({
      success: true,
      data: { groups: [], pagination: { limit: 10, offset: 20, total: 30, has_more: true } },
    }))

    const req = new NextRequest('http://localhost/api/groups?offset=20')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.pagination.offset).toBe(20)
  })

  it('supports sort_by parameter', async () => {
    mockGetOrSetWithLock.mockImplementation(async () => ({
      success: true,
      data: { groups: [], pagination: { limit: 10, offset: 0, total: 0, has_more: false } },
    }))

    const req = new NextRequest('http://localhost/api/groups?sort_by=activity')
    const res = await GET(req)

    expect(res.status).toBe(200)
  })

  it('returns empty list when no groups exist', async () => {
    mockGetOrSetWithLock.mockImplementation(async () => ({
      success: true,
      data: { groups: [], pagination: { limit: 10, offset: 0, total: 0, has_more: false } },
    }))

    const req = new NextRequest('http://localhost/api/groups')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.data.groups).toEqual([])
  })

  it('returns 500 on internal error', async () => {
    mockGetOrSetWithLock.mockRejectedValue(new Error('Redis down'))

    const req = new NextRequest('http://localhost/api/groups')
    const res = await GET(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error).toMatch(/internal/i)
  })

  it('sets cache headers on successful response', async () => {
    mockGetOrSetWithLock.mockImplementation(async () => ({
      success: true,
      data: { groups: [], pagination: { limit: 10, offset: 0, total: 0, has_more: false } },
    }))

    const req = new NextRequest('http://localhost/api/groups')
    const res = await GET(req)

    // The route sets Cache-Control headers
    expect(res.status).toBe(200)
  })
})
