jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    private readonly headerValues = new Map<string, string>()
    headers = {
      set: jest.fn((name: string, value: string) => this.headerValues.set(name, value)),
      get: jest.fn((name: string) => this.headerValues.get(name) ?? null),
    }

    constructor(
      private readonly body: unknown,
      init: { status?: number; headers?: Record<string, string> } = {}
    ) {
      this.status = init.status ?? 200
      for (const [name, value] of Object.entries(init.headers ?? {})) {
        this.headerValues.set(name, value)
      }
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

const mockFrom = jest.fn()
const mockCreateSignedUrls = jest.fn()
const mockStorageFrom = jest.fn(() => ({ createSignedUrls: mockCreateSignedUrls }))
const mockSupabase = {
  from: mockFrom,
  storage: { from: mockStorageFrom },
}
let mockAuthorized = true

jest.mock('@/lib/api/with-admin-auth', () => ({
  withAdminAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) =>
    async (request: unknown) => {
      const { NextResponse } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      if (!mockAuthorized) {
        return NextResponse.json(
          { success: false, error: 'Admin access required' },
          { status: 403 }
        )
      }
      try {
        return await handler({
          admin: { id: 'admin-id', email: 'admin@example.test' },
          supabase: mockSupabase,
          request,
        })
      } catch (error) {
        return NextResponse.json(
          { success: false, error: 'Database error' },
          { status: (error as { statusCode?: number }).statusCode ?? 500 }
        )
      }
    },
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { GET, POST } from '../route'

const REPORTER_ID = '11111111-1111-4111-8111-111111111111'
const EVIDENCE_FILE = '0123456789abcdef.png'
const EVIDENCE_REF = `reports/${REPORTER_ID}/${EVIDENCE_FILE}`

function reportsQuery(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn(() => chain)
  chain.eq = jest.fn(() => chain)
  chain.order = jest.fn(() => chain)
  chain.limit = jest.fn().mockResolvedValue(result)
  return chain
}

function profilesQuery(result: { data: unknown; error: unknown }) {
  const chain: Record<string, jest.Mock> = {}
  chain.select = jest.fn(() => chain)
  chain.in = jest.fn().mockResolvedValue(result)
  return chain
}

function request() {
  return {
    url: 'http://localhost/api/admin/reports?status=pending',
    method: 'GET',
  } as never
}

describe('GET /api/admin/reports private evidence', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    mockAuthorized = true
  })

  it('signs evidence only inside the admin boundary and supplies reporter fields', async () => {
    const report = {
      id: '22222222-2222-4222-8222-222222222222',
      content_type: 'post',
      content_id: '33333333-3333-4333-8333-333333333333',
      reporter_id: REPORTER_ID,
      reason: 'spam',
      description: 'Documented evidence for moderation.',
      images: [EVIDENCE_REF],
      status: 'pending',
      created_at: '2026-07-16T12:00:00.000Z',
      resolved_by: null,
      resolved_at: null,
      action_taken: null,
    }
    mockFrom.mockImplementation((table: string) => {
      if (table === 'content_reports') return reportsQuery({ data: [report], error: null })
      if (table === 'user_profiles') {
        return profilesQuery({
          data: [{ id: REPORTER_ID, handle: 'reporter', avatar_url: null }],
          error: null,
        })
      }
      throw new Error(`Unexpected table: ${table}`)
    })
    mockCreateSignedUrls.mockResolvedValue({
      data: [
        {
          path: `${REPORTER_ID}/${EVIDENCE_FILE}`,
          signedUrl: 'https://storage.test/signed/evidence',
          error: null,
        },
      ],
      error: null,
    })

    const response = await GET(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.data[0]).toMatchObject({
      description: report.description,
      details: report.description,
      images: ['https://storage.test/signed/evidence'],
      reporter: { id: REPORTER_ID, handle: 'reporter', avatar_url: null },
    })
    expect(mockStorageFrom).toHaveBeenCalledWith('reports')
  })

  it('does not query or sign evidence for a non-admin request', async () => {
    mockAuthorized = false

    const response = await GET(request())

    expect(response.status).toBe(403)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockStorageFrom).not.toHaveBeenCalled()
  })

  it('fails the whole response when private evidence signing fails', async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === 'content_reports') {
        return reportsQuery({
          data: [
            {
              id: '22222222-2222-4222-8222-222222222222',
              reporter_id: REPORTER_ID,
              description: 'Documented evidence for moderation.',
              images: [EVIDENCE_REF],
            },
          ],
          error: null,
        })
      }
      return profilesQuery({ data: [], error: null })
    })
    mockCreateSignedUrls.mockResolvedValue({
      data: null,
      error: { message: 'signing unavailable' },
    })

    const response = await GET(request())

    expect(response.status).toBe(500)
  })

  it('fails closed on the report query before signing anything', async () => {
    mockFrom.mockReturnValue(
      reportsQuery({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await GET(request())

    expect(response.status).toBe(500)
    expect(mockStorageFrom).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/reports retired write boundary', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
    mockAuthorized = true
  })

  it('always returns 405 without authenticating or writing a report row', async () => {
    const response = await POST()

    expect(response.status).toBe(405)
    expect(response.headers.get('Allow')).toBe('GET')
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockStorageFrom).not.toHaveBeenCalled()
  })
})
