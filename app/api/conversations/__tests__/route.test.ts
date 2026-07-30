/** @jest-environment node */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = '22222222-2222-4222-8222-222222222222'
const SECOND_OTHER_ID = '33333333-3333-4333-8333-333333333333'
const CONVERSATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const SECOND_CONVERSATION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
let mockUserId = ACTOR_ID

jest.mock('next/server', () => {
  class MockNextResponse {
    headers: Headers
    status: number

    constructor(
      private readonly body: unknown,
      init: { headers?: HeadersInit; status?: number } = {}
    ) {
      this.status = init.status ?? 200
      this.headers = new Headers(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { headers?: HeadersInit; status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: { id: mockUserId },
        supabase: { from: mockFrom, rpc: mockRpc },
        request,
      }),
}))

import { GET } from '../route'

function conversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    other_user: {
      id: OTHER_ID,
      handle: 'alice',
      avatar_url: null,
      bio: 'bio',
    },
    last_message_at: '2026-07-29T12:00:00.123456+00:00',
    last_message_preview: 'Hello',
    unread_count: 2,
    created_at: '2026-07-29T11:00:00+00:00',
    member_settings: {
      remark: 'VIP',
      is_muted: false,
      is_pinned: true,
      is_blocked: false,
    },
    ...overrides,
  }
}

function secondConversation(overrides: Record<string, unknown> = {}) {
  return conversation({
    id: SECOND_CONVERSATION_ID,
    other_user: {
      id: SECOND_OTHER_ID,
      handle: 'bob',
      avatar_url: 'https://img.example/bob',
      bio: null,
    },
    last_message_at: '2026-07-29T13:00:00+00:00',
    last_message_preview: null,
    unread_count: 0,
    member_settings: null,
    ...overrides,
  })
}

function acknowledgement(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    limit: 50,
    conversations: [conversation(), secondConversation()],
    ...overrides,
  }
}

describe('GET /api/conversations atomic authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockUserId = ACTOR_ID
    mockRpc.mockResolvedValue({ data: acknowledgement(), error: null })
    mockFrom.mockImplementation(() => {
      throw new Error('conversation list must not issue direct table reads')
    })
  })

  afterEach(() => {
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('returns one exact actor-bound inbox snapshot from one RPC', async () => {
    const response = await GET({} as never)

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      conversations: [conversation(), secondConversation()],
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('get_direct_message_conversation_list_atomic', {
      p_actor_id: ACTOR_ID,
      p_limit: 50,
    })
  })

  it('preserves a genuine authoritative empty list', async () => {
    mockRpc.mockResolvedValue({
      data: acknowledgement({ conversations: [] }),
      error: null,
    })

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ conversations: [] })
  })

  it('normalizes the session UUID before binding it to the RPC', async () => {
    mockUserId = ACTOR_ID.toUpperCase()

    const response = await GET({} as never)

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledWith('get_direct_message_conversation_list_atomic', {
      p_actor_id: ACTOR_ID,
      p_limit: 50,
    })
  })

  it('fails closed before the database when the session actor is malformed', async () => {
    mockUserId = 'not-an-actor'

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('maps authoritative actor unavailability to a private denial', async () => {
    mockRpc.mockResolvedValue({
      data: { success: false, reason: 'ACTOR_UNAVAILABLE' },
      error: null,
    })

    const response = await GET({} as never)

    expect(response.status).toBe(403)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({
      error: 'No permission to access conversations',
    })
  })

  it.each([
    ['database failure', { data: null, error: { message: 'database unavailable' } }],
    ['missing acknowledgement', { data: null, error: null }],
    ['extra acknowledgement key', { data: { ...acknowledgement(), stale: true }, error: null }],
    ['wrong actor binding', { data: acknowledgement({ actor_id: OTHER_ID }), error: null }],
    ['wrong limit binding', { data: acknowledgement({ limit: 49 }), error: null }],
    [
      'duplicate conversation',
      {
        data: acknowledgement({ conversations: [conversation(), conversation()] }),
        error: null,
      },
    ],
    [
      'duplicate counterparty',
      {
        data: acknowledgement({
          conversations: [
            conversation(),
            secondConversation({
              other_user: { id: OTHER_ID, handle: 'alice-duplicate', avatar_url: null, bio: null },
            }),
          ],
        }),
        error: null,
      },
    ],
    [
      'self counterparty',
      {
        data: acknowledgement({
          conversations: [
            conversation({
              other_user: { id: ACTOR_ID, handle: 'self', avatar_url: null, bio: null },
            }),
          ],
        }),
        error: null,
      },
    ],
    [
      'malformed timestamp',
      {
        data: acknowledgement({
          conversations: [conversation({ last_message_at: 'later' })],
        }),
        error: null,
      },
    ],
    [
      'database precision overflow',
      {
        data: acknowledgement({
          conversations: [conversation({ last_message_at: '2026-07-29T12:00:00.1234567Z' })],
        }),
        error: null,
      },
    ],
    [
      'deleted profile detail leak',
      {
        data: acknowledgement({
          conversations: [
            conversation({
              other_user: {
                id: OTHER_ID,
                handle: null,
                avatar_url: 'https://private.example/avatar',
                bio: null,
              },
            }),
          ],
        }),
        error: null,
      },
    ],
    [
      'pin ordering drift',
      {
        data: acknowledgement({ conversations: [secondConversation(), conversation()] }),
        error: null,
      },
    ],
    [
      'recency ordering drift',
      {
        data: acknowledgement({
          conversations: [
            conversation({ member_settings: null, last_message_at: '2026-07-29T11:00:00Z' }),
            secondConversation(),
          ],
        }),
        error: null,
      },
    ],
    [
      'impossible invalid request ACK',
      { data: { success: false, reason: 'INVALID' }, error: null },
    ],
  ])('fails closed on %s without any table-read fallback', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await GET({} as never)

    expect(response.status).toBe(500)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    await expect(response.json()).resolves.toEqual({ error: 'Failed to fetch conversations' })
  })

  it('contains no route-owned enrichment or read fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/conversations/route.ts'), 'utf8')

    expect(source).toContain("'get_direct_message_conversation_list_atomic'")
    expect(source).not.toContain(".from('conversations')")
    expect(source).not.toContain(".from('user_profiles')")
    expect(source).not.toContain(".from('direct_messages')")
    expect(source).not.toContain(".from('conversation_members')")
    expect(source).not.toContain('Promise.all')
  })
})
