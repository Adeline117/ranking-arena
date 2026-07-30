/**
 * Chat Settings & Search API Integration Tests
 * Tests permissions, CRUD operations, and search functionality.
 *
 * @jest-environment node
 */

import { NextRequest } from 'next/server'

// Mock Supabase
const mockSelect = jest.fn()
const mockInsert = jest.fn()
const mockUpdate = jest.fn()
const mockEq = jest.fn()
const mockIs = jest.fn()
const mockIlike = jest.fn()
const mockOrder = jest.fn()
const mockLimit = jest.fn()
const mockGt = jest.fn()
const mockGte = jest.fn()
const mockLte = jest.fn()
const mockLt = jest.fn()
const mockMaybeSingle = jest.fn()
const mockSingle = jest.fn()
const mockRpc = jest.fn()
const mockFrom = jest.fn(() => mockFromChain)
const mockInvalidateFollowingCache = jest.fn().mockResolvedValue(undefined)

const createChainedMock = () => {
  const chain: Record<string, jest.Mock> = {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    eq: mockEq,
    is: mockIs,
    ilike: mockIlike,
    order: mockOrder,
    limit: mockLimit,
    gt: mockGt,
    gte: mockGte,
    lte: mockLte,
    lt: mockLt,
    maybeSingle: mockMaybeSingle,
    single: mockSingle,
  }

  // Each method returns the chain itself
  Object.values(chain).forEach((mock) => {
    mock.mockReturnValue(chain)
  })

  return chain
}

const mockFromChain = createChainedMock()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: jest.fn(),
  getSupabaseAdmin: jest.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
  })),
}))

jest.mock('@/lib/features', () => ({ socialFeatureGuard: jest.fn(() => null) }))
jest.mock('@/app/api/following/route', () => ({
  invalidateFollowingCache: (...args: unknown[]) => mockInvalidateFollowingCache(...args),
}))

// Mock middleware to pass through — the search route now uses withAuth
jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => async (req: unknown, ctx: unknown) => {
    const { getAuthUser: gau, getSupabaseAdmin: gsa } = require('@/lib/supabase/server')
    const user = await gau(req)
    if (!user) {
      const { NextResponse: NR } = require('next/server')
      return NR.json({ error: 'Unauthorized' }, { status: 401 })
    }
    return handler({ user, supabase: gsa(), request: req, version: { current: 'v1' } }, ctx)
  },
  withPublic: (handler: Function) => handler,
}))

import { getAuthUser } from '@/lib/supabase/server'

const mockGetAuthUser = getAuthUser as jest.MockedFunction<typeof getAuthUser>

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = 'a0000000-0000-4000-8000-000000000001'
const UPDATED_AT = '2026-07-30T00:00:00.000Z'

function settingsAcknowledgement(
  appliedFields: string[],
  settings: Partial<{
    remark: string | null
    is_muted: boolean
    is_pinned: boolean
    is_blocked: boolean
    cleared_before: string | null
    updated_at: string
  }> = {},
  result: Partial<{
    actor_id: string
    target_id: string
    conversation_id: string
    created: boolean
    block_status: string | null
  }> = {}
) {
  return {
    success: true,
    actor_id: ACTOR_ID,
    target_id: TARGET_ID,
    conversation_id: CONVERSATION_ID,
    created: true,
    applied_fields: appliedFields,
    block_status: null,
    settings: {
      remark: null,
      is_muted: false,
      is_pinned: false,
      is_blocked: false,
      cleared_before: null,
      updated_at: UPDATED_AT,
      ...settings,
    },
    ...result,
  }
}

function createRequest(url: string, options: RequestInit = {}): NextRequest {
  const headers = new Headers(options.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'Jest Test Runner')
  return new NextRequest(new URL(url, 'http://localhost:3000'), { ...options, headers })
}

describe('Chat Settings API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset chain mocks
    Object.values(mockFromChain).forEach((mock) => {
      mock.mockReturnValue(mockFromChain)
    })
  })

  describe('GET /api/chat/[conversationId]/settings', () => {
    it('returns 401 for unauthenticated requests', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const { GET } = await import('../[conversationId]/settings/route')
      const request = createRequest('/api/chat/conv-123/settings')
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data.error).toBe('Unauthorized')
    })

    it('returns 403 for non-member access', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: 'user-999',
      } as unknown as import('@supabase/supabase-js').User)

      // Mock conversation exists but user is not a member
      mockMaybeSingle.mockResolvedValueOnce({
        data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
        error: null,
      })

      const { GET } = await import('../[conversationId]/settings/route')
      const request = createRequest('/api/chat/conv-123/settings')
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(403)
    })

    it('returns default settings when no member record exists', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: 'user-1',
      } as unknown as import('@supabase/supabase-js').User)

      // Mock conversation exists and user is a member
      mockMaybeSingle
        .mockResolvedValueOnce({
          data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
          error: null,
        })
        // No member settings record
        .mockResolvedValueOnce({ data: null, error: null })

      const { GET } = await import('../[conversationId]/settings/route')
      const request = createRequest('/api/chat/conv-123/settings', {
        headers: { Authorization: 'Bearer valid-token' },
      })
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.settings).toEqual({
        remark: null,
        is_muted: false,
        is_pinned: false,
        is_blocked: false,
        cleared_before: null,
        updated_at: null,
      })
    })
  })

  describe('PATCH /api/chat/[conversationId]/settings', () => {
    it('returns 401 for unauthenticated requests', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_muted: true }),
      })
      const response = await PATCH(request)

      expect(response.status).toBe(401)
      expect(mockRpc).not.toHaveBeenCalled()
    })

    it('returns 400 for empty body', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const response = await PATCH(request)

      expect(response.status).toBe(400)
      expect(mockRpc).not.toHaveBeenCalled()
    })

    it.each([
      [{ remark: 'a'.repeat(51) }],
      [{ is_muted: 'false' }],
      [{ clear_history: false }],
      [{ cleared_before: UPDATED_AT }],
      [{ is_pinned: true, unexpected: true }],
    ])('strictly rejects malformed or unknown input %#', async (body) => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const response = await PATCH(request)

      expect(response.status).toBe(400)
      expect(mockRpc).not.toHaveBeenCalled()
    })

    it('normalizes input and consumes exactly one typed settings RPC', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)
      mockRpc.mockResolvedValueOnce({
        data: settingsAcknowledgement(['remark', 'is_pinned'], {
          remark: 'Café',
          is_pinned: true,
        }),
        error: null,
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remark: '  Cafe\u0301  ', is_pinned: true }),
      })
      const response = await PATCH(request)

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.settings.remark).toBe('Café')
      expect(data.settings.is_pinned).toBe(true)
      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockRpc).toHaveBeenCalledWith('mutate_direct_message_conversation_settings_atomic', {
        p_conversation_id: CONVERSATION_ID,
        p_actor_id: ACTOR_ID,
        p_remark: 'Café',
        p_remark_present: true,
        p_is_muted: null,
        p_is_muted_present: false,
        p_is_pinned: true,
        p_is_pinned_present: true,
        p_is_blocked: null,
        p_is_blocked_present: false,
        p_clear_history: false,
      })
      expect(mockFrom).not.toHaveBeenCalled()
      expect(response.headers.get('cache-control')).toContain('no-store')
    })

    it('uses database-owned clear history instead of accepting a client timestamp', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)
      mockRpc.mockResolvedValueOnce({
        data: settingsAcknowledgement(['clear_history'], {
          cleared_before: UPDATED_AT,
        }),
        error: null,
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const response = await PATCH(
        createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clear_history: true }),
        })
      )

      expect(response.status).toBe(200)
      expect(mockRpc).toHaveBeenCalledWith(
        'mutate_direct_message_conversation_settings_atomic',
        expect.objectContaining({ p_clear_history: true })
      )
    })

    it('binds the chat block button to the canonical block result and invalidates both users', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)
      mockRpc.mockResolvedValueOnce({
        data: settingsAcknowledgement(
          ['is_blocked'],
          { is_blocked: true },
          { block_status: 'blocked' }
        ),
        error: null,
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const response = await PATCH(
        createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_blocked: true }),
        })
      )

      expect(response.status).toBe(200)
      expect(mockInvalidateFollowingCache).toHaveBeenCalledTimes(2)
      expect(mockInvalidateFollowingCache).toHaveBeenCalledWith(ACTOR_ID)
      expect(mockInvalidateFollowingCache).toHaveBeenCalledWith(TARGET_ID)
    })

    it.each([
      ['INVALID', 400],
      ['NOT_FOUND', 404],
      ['ACTOR_UNAVAILABLE', 403],
      ['PARTICIPANT_UNAVAILABLE', 403],
    ])('maps typed %s failures without a compatibility write', async (reason, status) => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)
      mockRpc.mockResolvedValueOnce({ data: { success: false, reason }, error: null })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const response = await PATCH(
        createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_muted: true }),
        })
      )

      expect(response.status).toBe(status)
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it.each([
      settingsAcknowledgement(['is_muted'], { is_muted: true }, { actor_id: TARGET_ID }),
      settingsAcknowledgement(['is_pinned'], { is_muted: true }),
      { ...settingsAcknowledgement(['is_muted'], { is_muted: true }), unexpected: true },
    ])('fails closed on malformed or mismatched database evidence %#', async (result) => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)
      mockRpc.mockResolvedValueOnce({ data: result, error: null })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const response = await PATCH(
        createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_muted: true }),
        })
      )

      expect(response.status).toBe(500)
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('fails closed when the atomic RPC errors and never falls back to table writes', async () => {
      mockGetAuthUser.mockResolvedValue({
        id: ACTOR_ID,
      } as unknown as import('@supabase/supabase-js').User)
      mockRpc.mockResolvedValueOnce({
        data: null,
        error: { code: '40001', message: 'retry' },
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const response = await PATCH(
        createRequest(`/api/chat/${CONVERSATION_ID}/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_muted: true }),
        })
      )

      expect(response.status).toBe(500)
      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockFrom).not.toHaveBeenCalled()
    })
  })
})

describe('Chat Search API', () => {
  const MESSAGE_ID = 'b0000000-0000-4000-8000-000000000001'

  function searchMessage(overrides: Record<string, unknown> = {}) {
    return {
      id: MESSAGE_ID,
      sender_id: TARGET_ID,
      content: 'Hello world',
      created_at: '2026-07-29T11:00:00.123456+00:00',
      ...overrides,
    }
  }

  function searchAcknowledgement(overrides: Record<string, unknown> = {}) {
    return {
      success: true,
      actor_id: ACTOR_ID,
      conversation_id: CONVERSATION_ID,
      query: 'hello',
      from_created_at: null,
      to_created_at: null,
      messages: [searchMessage()],
      has_more: false,
      next_cursor: null,
      ...overrides,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    Object.values(mockFromChain).forEach((mock) => {
      mock.mockReturnValue(mockFromChain)
    })
    mockGetAuthUser.mockResolvedValue({
      id: ACTOR_ID,
    } as unknown as import('@supabase/supabase-js').User)
    mockRpc.mockResolvedValue({ data: searchAcknowledgement(), error: null })
  })

  describe('GET /api/chat/[conversationId]/search', () => {
    it('returns 401 for unauthenticated requests', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/search?q=hello`)
      const response = await GET(request, { params: { conversationId: CONVERSATION_ID } })

      expect(response.status).toBe(401)
    })

    it('returns one exact request-bound page from one RPC', async () => {
      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/search?q=%20hello%20`, {
        headers: { Authorization: 'Bearer valid-token' },
      })
      const response = await GET(request, { params: { conversationId: CONVERSATION_ID } })

      expect(response.status).toBe(200)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      const data = await response.json()
      expect(data).toEqual({
        matches: [
          {
            message_id: MESSAGE_ID,
            sender_id: TARGET_ID,
            snippet: 'Hello world',
            created_at: '2026-07-29T11:00:00.123456+00:00',
          },
        ],
        next_cursor: null,
        total_in_page: 1,
      })
      expect(mockRpc).toHaveBeenCalledTimes(1)
      expect(mockRpc).toHaveBeenCalledWith('search_direct_message_conversation_atomic', {
        p_actor_id: ACTOR_ID,
        p_before_created_at: null,
        p_before_id: null,
        p_conversation_id: CONVERSATION_ID,
        p_from_created_at: null,
        p_limit: 20,
        p_query: 'hello',
        p_to_created_at: null,
      })
      expect(mockFrom).not.toHaveBeenCalled()
    })

    it('binds the total cursor, inclusive date range, and limit into the RPC', async () => {
      const cursor = '2026-07-29T12:00:00.123456+00:00'
      const from = '2026-07-29T10:00:00+00:00'
      const to = '2026-07-29T11:00:00.123456+00:00'
      mockRpc.mockResolvedValue({
        data: searchAcknowledgement({
          from_created_at: from,
          to_created_at: to,
          has_more: true,
          next_cursor: {
            before: '2026-07-29T11:00:00.123456+00:00',
            before_id: MESSAGE_ID,
          },
        }),
        error: null,
      })

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest(
        `/api/chat/${CONVERSATION_ID}/search?q=hello&limit=1&cursor=${encodeURIComponent(cursor)}&cursorId=${MESSAGE_ID}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
      )
      const response = await GET(request, { params: { conversationId: CONVERSATION_ID } })

      expect(response.status).toBe(200)
      expect(mockRpc).toHaveBeenCalledWith(
        'search_direct_message_conversation_atomic',
        expect.objectContaining({
          p_before_created_at: cursor,
          p_before_id: MESSAGE_ID,
          p_from_created_at: from,
          p_to_created_at: to,
          p_limit: 1,
        })
      )
    })

    it.each([
      [`/api/chat/${CONVERSATION_ID}/search?q=`, CONVERSATION_ID, 'empty query'],
      [
        `/api/chat/${CONVERSATION_ID}/search?q=hello&cursor=2026-07-29T12%3A00%3A00Z`,
        CONVERSATION_ID,
        'half cursor',
      ],
      [`/api/chat/${CONVERSATION_ID}/search?q=hello&limit=51`, CONVERSATION_ID, 'oversized limit'],
      [
        `/api/chat/${CONVERSATION_ID}/search?q=hello&unknown=1`,
        CONVERSATION_ID,
        'unknown parameter',
      ],
      [
        `/api/chat/${CONVERSATION_ID}/search?q=hello&q=again`,
        CONVERSATION_ID,
        'duplicate parameter',
      ],
      [
        `/api/chat/${CONVERSATION_ID}/search?q=hello&from=2026-07-30T00%3A00%3A00Z&to=2026-07-29T00%3A00%3A00Z`,
        CONVERSATION_ID,
        'inverted dates',
      ],
      [`/api/chat/not-a-uuid/search?q=hello`, 'not-a-uuid', 'invalid conversation'],
    ])('rejects %s (%s)', async (url, conversationId, _label) => {
      const { GET } = await import('../[conversationId]/search/route')
      const response = await GET(createRequest(url), { params: { conversationId } })

      expect(response.status).toBe(400)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(mockRpc).not.toHaveBeenCalled()
    })

    it.each([
      ['database failure', { data: null, error: { message: 'unavailable' } }, 500],
      ['missing acknowledgement', { data: null, error: null }, 500],
      ['not found', { data: { success: false, reason: 'NOT_FOUND' }, error: null }, 404],
      [
        'actor unavailable',
        { data: { success: false, reason: 'ACTOR_UNAVAILABLE' }, error: null },
        403,
      ],
      [
        'extra acknowledgement field',
        { data: { ...searchAcknowledgement(), stale: true }, error: null },
        500,
      ],
      [
        'wrong actor binding',
        { data: searchAcknowledgement({ actor_id: TARGET_ID }), error: null },
        500,
      ],
      [
        'wrong query binding',
        { data: searchAcknowledgement({ query: 'other' }), error: null },
        500,
      ],
      [
        'duplicate message',
        {
          data: searchAcknowledgement({ messages: [searchMessage(), searchMessage()] }),
          error: null,
        },
        500,
      ],
      [
        'unsorted page',
        {
          data: searchAcknowledgement({
            messages: [
              searchMessage({ created_at: '2026-07-29T10:00:00Z' }),
              searchMessage({
                id: 'b0000000-0000-4000-8000-000000000002',
                created_at: '2026-07-29T12:00:00Z',
              }),
            ],
          }),
          error: null,
        },
        500,
      ],
      [
        'cursor mismatch',
        {
          data: searchAcknowledgement({
            has_more: true,
            next_cursor: {
              before: '2026-07-29T11:00:00.123456+00:00',
              before_id: 'b0000000-0000-4000-8000-000000000099',
            },
          }),
          error: null,
        },
        500,
      ],
    ])('fails closed on %s without direct-table fallback', async (_label, result, status) => {
      mockRpc.mockResolvedValue(result)

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest(`/api/chat/${CONVERSATION_ID}/search?q=hello`)
      const response = await GET(request, { params: { conversationId: CONVERSATION_ID } })

      expect(response.status).toBe(status)
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
      expect(mockFrom).not.toHaveBeenCalled()
    })
  })
})
