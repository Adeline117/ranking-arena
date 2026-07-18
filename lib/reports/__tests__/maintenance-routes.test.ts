jest.mock('next/server', () => {
  class MockHeaders {
    private readonly values = new Map<string, string>()

    constructor(headers: Record<string, string> = {}) {
      for (const [name, value] of Object.entries(headers)) {
        this.values.set(name.toLowerCase(), value)
      }
    }

    get(name: string) {
      return this.values.get(name.toLowerCase()) ?? null
    }
  }

  class MockNextResponse {
    readonly status: number
    readonly headers: MockHeaders

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new MockHeaders(init.headers)
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

let mockUser: { id: string } | null
const mockFrom = jest.fn()
const mockStorageFrom = jest.fn()
const mockSupabase = {
  from: mockFrom,
  storage: { from: mockStorageFrom },
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (request: unknown) => {
      const { NextResponse } = require('next/server') as typeof import('next/server')
      if (!mockUser) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
      }
      return handler({ user: mockUser, supabase: mockSupabase, request })
    },
}))

import { POST as legacyReportPost } from '@/app/api/report/route'
import { POST as reportPost } from '@/app/api/reports/route'
import { POST as uploadPost } from '@/app/api/upload/route'
import {
  REPORT_MAINTENANCE_BODY,
  REPORT_MAINTENANCE_RETRY_AFTER_SECONDS,
} from '@/lib/reports/maintenance'

const routes = [
  ['/api/report', legacyReportPost],
  ['/api/reports', reportPost],
  ['/api/upload', uploadPost],
] as const

describe.each(routes)('POST %s report maintenance boundary', (_path, post) => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUser = { id: '11111111-1111-4111-8111-111111111111' }
  })

  it('returns the deterministic authenticated maintenance response without I/O', async () => {
    const request = {
      json: jest.fn(),
      formData: jest.fn(),
    }

    const response = await post(request as never)

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual(REPORT_MAINTENANCE_BODY)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(response.headers.get('Retry-After')).toBe(String(REPORT_MAINTENANCE_RETRY_AFTER_SECONDS))
    expect(request.json).not.toHaveBeenCalled()
    expect(request.formData).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockStorageFrom).not.toHaveBeenCalled()
  })

  it('preserves the authentication boundary', async () => {
    mockUser = null

    const response = await post({} as never)

    expect(response.status).toBe(401)
  })
})
