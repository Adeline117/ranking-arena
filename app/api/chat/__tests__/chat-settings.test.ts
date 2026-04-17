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
const mockIlike = jest.fn()
const mockOrder = jest.fn()
const mockLimit = jest.fn()
const mockGt = jest.fn()
const mockGte = jest.fn()
const mockLte = jest.fn()
const mockLt = jest.fn()
const mockMaybeSingle = jest.fn()
const mockSingle = jest.fn()

const createChainedMock = () => {
  const chain: Record<string, jest.Mock> = {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
    eq: mockEq,
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
  Object.values(chain).forEach(mock => {
    mock.mockReturnValue(chain)
  })

  return chain
}

const mockFromChain = createChainedMock()

jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: jest.fn(),
  getSupabaseAdmin: jest.fn(() => ({
    from: jest.fn(() => mockFromChain),
  })),
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

function createRequest(url: string, options: RequestInit = {}): NextRequest {
  const headers = new Headers(options.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'Jest Test Runner')
  return new NextRequest(new URL(url, 'http://localhost:3000'), { ...options, headers })
}

describe('Chat Settings API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Reset chain mocks
    Object.values(mockFromChain).forEach(mock => {
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
      mockGetAuthUser.mockResolvedValue({ id: 'user-999' } as unknown as import('@supabase/supabase-js').User)

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
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

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
        headers: { 'Authorization': 'Bearer valid-token' },
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
      const request = createRequest('/api/chat/conv-123/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_muted: true }),
      })
      const response = await PATCH(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(401)
    })

    it('returns 400 for empty body', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

      mockMaybeSingle.mockResolvedValueOnce({
        data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
        error: null,
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest('/api/chat/conv-123/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const response = await PATCH(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(400)
    })

    it('returns 400 for remark exceeding 50 characters', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

      mockMaybeSingle.mockResolvedValueOnce({
        data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
        error: null,
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest('/api/chat/conv-123/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remark: 'a'.repeat(51) }),
      })
      const response = await PATCH(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(400)
      const data = await response.json()
      expect(data.error).toBe('Nickname max 50 characters')
    })

    it('creates settings record when none exists', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

      // conversation check
      mockMaybeSingle.mockResolvedValueOnce({
        data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
        error: null,
      })
      // no existing record
      mockMaybeSingle.mockResolvedValueOnce({ data: null, error: null })
      // insert result
      mockSingle.mockResolvedValueOnce({
        data: {
          remark: 'Test Remark',
          is_muted: false,
          is_pinned: true,
          is_blocked: false,
          cleared_before: null,
          updated_at: '2024-01-01T00:00:00Z',
        },
        error: null,
      })

      const { PATCH } = await import('../[conversationId]/settings/route')
      const request = createRequest('/api/chat/conv-123/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ remark: 'Test Remark', is_pinned: true }),
      })
      const response = await PATCH(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.settings.remark).toBe('Test Remark')
      expect(data.settings.is_pinned).toBe(true)
    })
  })
})

describe('Chat Search API', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    Object.values(mockFromChain).forEach(mock => {
      mock.mockReturnValue(mockFromChain)
    })
  })

  describe('GET /api/chat/[conversationId]/search', () => {
    it('returns 401 for unauthenticated requests', async () => {
      mockGetAuthUser.mockResolvedValue(null)

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest('/api/chat/conv-123/search?q=hello')
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(401)
    })

    it('returns 400 for empty query', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest('/api/chat/conv-123/search?q=')
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(400)
    })

    it('returns 403 for non-member search', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-999' } as unknown as import('@supabase/supabase-js').User)

      mockMaybeSingle.mockResolvedValueOnce({
        data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
        error: null,
      })

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest('/api/chat/conv-123/search?q=hello')
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(403)
    })

    it('returns search results with snippets for members', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

      // conversation check
      mockMaybeSingle
        .mockResolvedValueOnce({
          data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
          error: null,
        })
        // member settings (no cleared_before)
        .mockResolvedValueOnce({ data: null, error: null })

      // Search results - returned from the chained query
      // The final call in the chain resolves with the data
      const searchResults = [
        { id: 'msg-1', content: 'Hello world', created_at: '2024-01-01T10:00:00Z', sender_id: 'user-1' },
        { id: 'msg-2', content: 'Hello there', created_at: '2024-01-01T09:00:00Z', sender_id: 'user-2' },
      ]

      // Override the final resolution of the chain (after all filters applied)
      // The search query chain ends without maybeSingle/single - it resolves directly
      mockLimit.mockResolvedValueOnce({ data: searchResults, error: null })

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest('/api/chat/conv-123/search?q=hello', {
        headers: { 'Authorization': 'Bearer valid-token' },
      })
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(200)
      const data = await response.json()
      expect(data.matches).toHaveLength(2)
      expect(data.matches[0].message_id).toBe('msg-1')
      expect(data.matches[0].snippet).toContain('Hello')
      expect(data.next_cursor).toBeNull()
    })

    it('respects cleared_before filter', async () => {
      mockGetAuthUser.mockResolvedValue({ id: 'user-1' } as unknown as import('@supabase/supabase-js').User)

      mockMaybeSingle
        .mockResolvedValueOnce({
          data: { id: 'conv-123', user1_id: 'user-1', user2_id: 'user-2' },
          error: null,
        })
        .mockResolvedValueOnce({
          data: { cleared_before: '2024-01-01T08:00:00Z' },
          error: null,
        })

      // limit() is the final call and returns the awaited result
      mockLimit.mockResolvedValueOnce({ data: [], error: null })

      const { GET } = await import('../[conversationId]/search/route')
      const request = createRequest('/api/chat/conv-123/search?q=hello', {
        headers: { 'Authorization': 'Bearer valid-token' },
      })
      const response = await GET(request, { params: { conversationId: 'conv-123' } })

      expect(response.status).toBe(200)
      // gt was called with cleared_before timestamp
      expect(mockGt).toHaveBeenCalled()
    })
  })
})
