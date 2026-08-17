const mockAdmin = {
  email: 'admin@example.test',
  id: '11111111-1111-4111-8111-111111111111',
}

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers: Headers

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth:
    (handler: (context: { admin: typeof mockAdmin }) => Promise<unknown>) => async () =>
      handler({ admin: mockAdmin }),
}))

import { GET } from './route'

describe('GET /api/admin/authority', () => {
  it('returns an exact private actor-bound authority receipt', async () => {
    const response = await GET({} as never)
    const payload = await response.json()

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(response.headers.get('vary')).toBe('Authorization')
    expect(payload).toEqual({
      success: true,
      data: { admin: mockAdmin },
      meta: { timestamp: expect.any(String) },
    })
  })
})
