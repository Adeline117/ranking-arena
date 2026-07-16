jest.mock('next/server', () => {
  class MockNextResponse {
    status: number

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

const mockFrom = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { from: mockFrom },
        request,
      }),
}))

jest.mock('@/lib/utils/logger', () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }
  return { logger, createLogger: () => logger }
})

import { POST } from '../route'

const REPORTER_ID = '11111111-1111-4111-8111-111111111111'
const CONTENT_ID = '22222222-2222-4222-8222-222222222222'

type QueryResult = { data: unknown; error: unknown }

function query(result: QueryResult) {
  const chain: Record<string, jest.Mock> = {}
  for (const method of ['select', 'eq', 'insert']) {
    chain[method] = jest.fn(() => chain)
  }
  chain.maybeSingle = jest.fn().mockResolvedValue(result)
  chain.single = jest.fn().mockResolvedValue(result)
  return chain
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    json: async () => ({
      content_type: 'post',
      content_id: CONTENT_ID,
      reason: 'spam',
      description: '  This is documented report evidence.  ',
      images: ['https://evidence.example/report.png'],
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
  })

  test.each([
    ['non-UUID content ID', { content_id: 'post-123' }],
    ['base64 evidence', { images: ['data:image/png;base64,AAAA'] }],
    ['insecure evidence URL', { images: ['http://evidence.example/report.png'] }],
    ['non-string evidence', { images: [123] }],
  ])('rejects %s before any database call', async (_label, overrides) => {
    const response = await POST(request(overrides))
    const body = await responseBody(response)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when the duplicate lookup fails', async () => {
    mockFrom.mockReturnValueOnce(query({ data: null, error: { code: 'XX000' } }))

    const response = await POST(request())
    const body = await responseBody(response)

    expect(response.status).toBe(500)
    expect(body).toMatchObject({
      success: false,
      error: { code: 'DATABASE_ERROR' },
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('returns a conflict for an existing pending report without writing', async () => {
    mockFrom.mockReturnValueOnce(query({ data: { id: 'report-1' }, error: null }))

    const response = await POST(request())
    const body = await responseBody(response)

    expect(response.status).toBe(409)
    expect(body).toMatchObject({
      success: false,
      error: { code: 'DUPLICATE_ACTION' },
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('rejects a missing post before inserting a report', async () => {
    mockFrom
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(query({ data: null, error: null }))

    const response = await POST(request())
    const body = await responseBody(response)

    expect(response.status).toBe(404)
    expect(body).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } })
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('rejects reporting your own comment', async () => {
    mockFrom.mockReturnValueOnce(query({ data: null, error: null })).mockReturnValueOnce(
      query({
        data: { id: CONTENT_ID, user_id: REPORTER_ID, deleted_at: null },
        error: null,
      })
    )

    const response = await POST(request({ content_type: 'comment' }))
    const body = await responseBody(response)

    expect(response.status).toBe(400)
    expect(body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    })
    expect(mockFrom).toHaveBeenCalledTimes(2)
  })

  it('inserts only normalized bounded evidence for an existing target', async () => {
    const duplicateQuery = query({ data: null, error: null })
    const targetQuery = query({
      data: {
        id: CONTENT_ID,
        author_id: '33333333-3333-4333-8333-333333333333',
        status: 'active',
        deleted_at: null,
      },
      error: null,
    })
    const insertQuery = query({
      data: {
        id: '44444444-4444-4444-8444-444444444444',
        content_type: 'post',
        reason: 'spam',
        status: 'pending',
        created_at: '2026-07-16T12:00:00.000Z',
      },
      error: null,
    })
    mockFrom
      .mockReturnValueOnce(duplicateQuery)
      .mockReturnValueOnce(targetQuery)
      .mockReturnValueOnce(insertQuery)

    const response = await POST(request())
    const body = await responseBody(response)

    expect(response.status).toBe(201)
    expect(body).toMatchObject({ success: true })
    expect(insertQuery.insert).toHaveBeenCalledWith({
      reporter_id: REPORTER_ID,
      content_type: 'post',
      content_id: CONTENT_ID,
      reason: 'spam',
      description: 'This is documented report evidence.',
      images: ['https://evidence.example/report.png'],
      status: 'pending',
    })
  })
})
