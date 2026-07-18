const mockFrom = jest.fn()

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

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        supabase: { from: mockFrom },
        request,
      }),
}))

import { GET } from '../route'

function queryResult(result: { data: unknown; error: unknown }) {
  const query = {
    select: jest.fn(() => query),
    or: jest.fn(() => query),
    order: jest.fn(() => query),
    limit: jest.fn(async () => result),
  }
  return query
}

describe('GET /api/conversations', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns a genuine empty list when the conversation query succeeds with no rows', async () => {
    mockFrom.mockReturnValue(queryResult({ data: [], error: null }))

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ conversations: [] })
  })

  it.each([
    'Could not find the table public.conversations in the schema cache',
    'connection terminated unexpectedly',
  ])(
    'surfaces a conversation query failure instead of disguising it as empty: %s',
    async (message) => {
      mockFrom.mockReturnValue(queryResult({ data: null, error: { message } }))

      const response = await GET({} as never)

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch conversations' })
    }
  )
})
