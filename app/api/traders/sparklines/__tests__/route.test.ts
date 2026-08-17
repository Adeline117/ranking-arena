const mockRpc = jest.fn()
const mockFrom = jest.fn()

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Headers

    constructor(body?: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(data, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: (context: { supabase: { from: typeof mockFrom; rpc: typeof mockRpc } }) => unknown) =>
    () =>
      handler({ supabase: { from: mockFrom, rpc: mockRpc } }),
}))

import { POST } from '../route'

describe('POST /api/traders/sparklines historical series boundary', () => {
  beforeEach(() => {
    mockFrom.mockReset()
    mockRpc.mockReset()
  })

  it('returns an empty no-store map without reading an RPC or raw table', async () => {
    const response = await POST({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({})
    expect(response.headers.get('Cache-Control')).toBe('private, no-store, max-age=0')
    expect(response.headers.get('CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Vercel-CDN-Cache-Control')).toBe('no-store')
    expect(response.headers.get('Pragma')).toBe('no-cache')
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
