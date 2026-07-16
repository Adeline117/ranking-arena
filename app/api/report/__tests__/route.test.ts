jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Map<string, string>
    private readonly body: unknown

    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {}
  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockGetAuthUser = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: jest.fn(() => {
    throw new Error('Retired report endpoint must not create a database client')
  }),
}))

import { POST } from '../route'

describe('POST /api/report retirement', () => {
  beforeEach(() => jest.clearAllMocks())

  it('preserves the authentication boundary', async () => {
    mockGetAuthUser.mockResolvedValue(null)
    const response = await POST({} as never)
    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns explicit 410 with the canonical successor and no side effects', async () => {
    mockGetAuthUser.mockResolvedValue({ id: '11111111-1111-4111-8111-111111111111' })
    const response = await POST({} as never)
    const body = await response.json()

    expect(response.status).toBe(410)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Deprecation')).toBe('true')
    expect(response.headers.get('Link')).toContain('/api/reports')
    expect(body).toMatchObject({
      success: false,
      code: 'REPORT_ENDPOINT_RETIRED',
      successor: '/api/reports',
    })
    expect(mockGetAuthUser).toHaveBeenCalledTimes(1)
  })
})
