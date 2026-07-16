jest.mock('next/server', () => {
  class MockNextResponse {
    status: number
    headers = new Map<string, string>()

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockFrom = jest.fn(() => {
  throw new Error('Report submission must not access tables directly')
})
const mockRpc = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { from: mockFrom, rpc: mockRpc },
        request,
      }),
}))

jest.mock('@/lib/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return { logger, createLogger: () => logger }
})

import { POST } from '../route'

const REPORTER_ID = '11111111-1111-4111-8111-111111111111'
const CONTENT_ID = '22222222-2222-4222-8222-222222222222'
const REPORT_ID = '44444444-4444-4444-8444-444444444444'
const EVIDENCE_REF = `reports/${REPORTER_ID}/0123456789abcdef.png`
const CREATED_AT = '2026-07-16T12:00:00.000Z'

const createdResult = {
  created: true,
  report_id: REPORT_ID,
  status: 'pending',
  content_type: 'post',
  reason: 'spam',
  created_at: CREATED_AT,
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    json: async () => ({
      content_type: 'post',
      content_id: CONTENT_ID,
      reason: 'spam',
      description: '  This is documented report evidence.  ',
      images: [EVIDENCE_REF],
      ...overrides,
    }),
  } as never
}

async function responseBody(response: Awaited<ReturnType<typeof POST>>) {
  return response.json() as Promise<Record<string, unknown>>
}

describe('POST /api/reports', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: createdResult, error: null })
  })

  test.each([
    ['non-UUID content ID', { content_id: 'post-123' }],
    ['base64 evidence', { images: ['data:image/png;base64,AAAA'] }],
    ['external evidence URL', { images: ['https://evidence.example/report.png'] }],
    [
      'another reporter evidence',
      { images: ['reports/99999999-9999-4999-8999-999999999999/0123456789abcdef.png'] },
    ],
    ['duplicate evidence', { images: [EVIDENCE_REF, EVIDENCE_REF] }],
    ['non-string evidence', { images: [123] }],
  ])('rejects %s before any database call', async (_label, overrides) => {
    const response = await POST(request(overrides))
    const body = await responseBody(response)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } })
    expect(mockRpc).not.toHaveBeenCalled()
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('submits only through the canonical RPC', async () => {
    const response = await POST(request())
    const body = await responseBody(response)

    expect(response.status).toBe(201)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(body).toMatchObject({
      success: true,
      data: {
        report: {
          id: REPORT_ID,
          content_type: 'post',
          reason: 'spam',
          status: 'pending',
          created_at: CREATED_AT,
        },
      },
    })
    expect(mockRpc).toHaveBeenCalledWith('submit_content_report', {
      p_reporter_id: REPORTER_ID,
      p_content_type: 'post',
      p_content_id: CONTENT_ID,
      p_reason: 'spam',
      p_description: 'This is documented report evidence.',
      p_images: [EVIDENCE_REF],
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('maps an exact canonical duplicate result to the stable conflict response', async () => {
    mockRpc.mockResolvedValue({
      data: {
        created: false,
        report_id: REPORT_ID,
        status: 'pending',
        reason: 'DUPLICATE_PENDING',
        content_type: 'post',
        created_at: CREATED_AT,
      },
      error: null,
    })

    const response = await POST(request())
    expect(response.status).toBe(409)
    await expect(responseBody(response)).resolves.toMatchObject({
      success: false,
      error: { code: 'DUPLICATE_ACTION' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  test.each(['PGRST202', '42883', '42501', 'XX000'])(
    'fails closed on RPC error %s without table fallback',
    async (code) => {
      mockRpc.mockResolvedValue({ data: null, error: { code } })

      const response = await POST(request())
      expect(response.status).toBe(500)
      await expect(responseBody(response)).resolves.toMatchObject({
        success: false,
        error: { code: 'DATABASE_ERROR' },
      })
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  test.each([
    ['invalid UUID', { ...createdResult, report_id: 'report-1' }],
    ['invalid timestamp', { ...createdResult, created_at: 'yesterday' }],
    ['wrong content type', { ...createdResult, content_type: 'comment' }],
    ['wrong reason', { ...createdResult, reason: 'fraud' }],
    ['missing timestamp', { ...createdResult, created_at: undefined }],
    ['unexpected field', { ...createdResult, legacy: true }],
  ])('fails closed on a structurally invalid RPC result: %s', async (_label, data) => {
    mockRpc.mockResolvedValue({ data, error: null })

    const response = await POST(request())
    expect(response.status).toBe(500)
    await expect(responseBody(response)).resolves.toMatchObject({
      success: false,
      error: { code: 'DATABASE_ERROR' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
