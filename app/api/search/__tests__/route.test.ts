jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown; status: number
    constructor(body?: unknown, init: any = {}) {
      this._body = body; this.status = init.status || 200
    }
    async json() { return this._body }
    static json(data: unknown, init?: any) { return new MockNextResponse(data, init) }
  }
  class MockNextRequest {
    url: string; nextUrl: any
    constructor(url: string) { this.url = url; this.nextUrl = new URL(url) }
  }
  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/cache', () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn(),
}))

const mockFrom = jest.fn(() => ({
  select: jest.fn().mockReturnThis(),
  or: jest.fn().mockReturnThis(),
  ilike: jest.fn().mockReturnThis(),
  order: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue({ data: [], error: null }),
  textSearch: jest.fn().mockReturnThis(),
  insert: jest.fn().mockResolvedValue({ data: null, error: null }),
  eq: jest.fn().mockReturnThis(),
}))

jest.mock('@/lib/api/middleware', () => ({
  withPublic: (handler: any) => {
    return async (req: any) => {
      return handler({ supabase: { from: mockFrom }, request: req })
    }
  },
}))

jest.mock('@/lib/api/response', () => ({
  success: (data: any) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json(data)
  },
}))

import { NextRequest } from 'next/server'
import { GET } from '../route'

describe('GET /api/search', () => {
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
})
