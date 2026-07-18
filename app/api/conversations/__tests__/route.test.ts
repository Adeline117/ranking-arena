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
    eq: jest.fn(() => query),
    is: jest.fn(() => query),
    in: jest.fn(() => query),
    then: (
      resolve: (value: { data: unknown; error: unknown }) => unknown,
      reject: (reason: unknown) => unknown
    ) => Promise.resolve(result).then(resolve, reject),
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

  it.each(['user_profiles', 'direct_messages', 'conversation_members'])(
    'surfaces a %s enrichment failure instead of returning incomplete conversation data',
    async (failingTable) => {
      const conversation = {
        id: 'conversation-1',
        user1_id: '11111111-1111-4111-8111-111111111111',
        user2_id: '22222222-2222-4222-8222-222222222222',
        last_message_at: '2026-07-18T12:00:00.000Z',
        last_message_preview: 'Hello',
        created_at: '2026-07-18T11:00:00.000Z',
      }
      const results: Record<string, { data: unknown; error: unknown }> = {
        conversations: { data: [conversation], error: null },
        user_profiles: {
          data: [
            {
              id: conversation.user2_id,
              handle: 'alice',
              avatar_url: null,
              bio: null,
            },
          ],
          error: null,
        },
        direct_messages: { data: [], error: null },
        conversation_members: { data: [], error: null },
      }
      results[failingTable] = { data: null, error: { message: 'database unavailable' } }
      mockFrom.mockImplementation((table: string) => queryResult(results[table]))

      const response = await GET({} as never)

      expect(response.status).toBe(500)
      await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch conversations' })
    }
  )
})
