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

  it('hides conversations cleared since their last message and only counts newer unread', async () => {
    const me = '11111111-1111-4111-8111-111111111111'
    const conv = (id: string, last: string) => ({
      id,
      user1_id: me,
      user2_id: '22222222-2222-4222-8222-222222222222',
      last_message_at: last,
      last_message_preview: id,
      created_at: '2026-07-01T00:00:00.000Z',
    })
    const results: Record<string, { data: unknown; error: unknown }> = {
      conversations: {
        data: [
          conv('deleted', '2026-07-10T00:00:00.000Z'),
          conv('revived', '2026-07-20T00:00:00.000Z'),
          conv('plain', '2026-07-05T00:00:00.000Z'),
        ],
        error: null,
      },
      user_profiles: { data: [], error: null },
      direct_messages: {
        data: [
          { conversation_id: 'deleted', created_at: '2026-07-09T00:00:00.000Z' },
          { conversation_id: 'revived', created_at: '2026-07-11T00:00:00.000Z' },
          { conversation_id: 'revived', created_at: '2026-07-20T00:00:00.000Z' },
          { conversation_id: 'plain', created_at: '2026-07-05T00:00:00.000Z' },
        ],
        error: null,
      },
      conversation_members: {
        data: [
          {
            conversation_id: 'deleted',
            remark: null,
            is_muted: false,
            is_pinned: false,
            is_blocked: false,
            cleared_before: '2026-07-15T00:00:00.000Z',
          },
          {
            conversation_id: 'revived',
            remark: null,
            is_muted: false,
            is_pinned: false,
            is_blocked: false,
            cleared_before: '2026-07-15T00:00:00.000Z',
          },
        ],
        error: null,
      },
    }
    mockFrom.mockImplementation((table: string) => queryResult(results[table]))

    const response = await GET({} as never)
    const body = (await response.json()) as {
      conversations: Array<{ id: string; unread_count: number }>
    }

    expect(body.conversations.map((c) => [c.id, c.unread_count])).toEqual([
      ['revived', 1],
      ['plain', 1],
    ])
  })
})
