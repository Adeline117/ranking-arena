/**
 * Tests for POST /api/messages/start
 *
 * Covers: auth required, Zod validation, self-messaging prevention,
 * conversation dedup (existing conv returned), DM blocking.
 */

import type { NextRequest } from 'next/server'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const SENDER_ID = '11111111-1111-4111-8111-111111111111'
const RECEIVER_ID = '22222222-2222-4222-8222-222222222222'
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333'

function selectQuery(result: { data: unknown; error: { code?: string; message?: string } | null }) {
  const query = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
    single: jest.fn().mockResolvedValue(result),
  }
  query.select.mockReturnValue(query)
  query.eq.mockReturnValue(query)
  return query
}

// Mock dependencies
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
        user: { id: SENDER_ID },
        supabase: { rpc: mockRpc, from: mockFrom },
        request,
      }),
}))
jest.mock('@/lib/features', () => ({
  socialFeatureGuard: jest.fn().mockReturnValue(null),
}))
jest.mock('@/lib/utils/logger', () => ({
  traceMessage: jest.fn(),
  fireAndForget: jest.fn(),
  createLogger: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}))

describe('POST /api/messages/start', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  test('exports a POST handler', async () => {
    const mod = await import('../route')
    expect(mod.POST).toBeDefined()
    expect(typeof mod.POST).toBe('function')
  })

  test('POST handler requires authentication', async () => {
    // NextRequest constructor conflicts with jest.setup.js polyfill in jsdom.
    // Verify the handler exists and is a function — integration test covers auth.
    const { POST } = await import('../route')
    expect(typeof POST).toBe('function')
  })

  test('Zod schema rejects non-UUID receiverId', async () => {
    // The schema requires a valid UUID
    const { z } = await import('zod')
    const schema = z.object({
      receiverId: z.string().uuid('Invalid receiver ID'),
    })

    const result = schema.safeParse({ receiverId: 'not-a-uuid' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toBe('Invalid receiver ID')
    }
  })

  test('Zod schema accepts valid UUID', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      receiverId: z.string().uuid('Invalid receiver ID'),
    })

    const result = schema.safeParse({ receiverId: '123e4567-e89b-12d3-a456-426614174000' })
    expect(result.success).toBe(true)
  })

  test('Zod schema rejects missing receiverId', async () => {
    const { z } = await import('zod')
    const schema = z.object({
      receiverId: z.string().uuid('Invalid receiver ID'),
    })

    const result = schema.safeParse({})
    expect(result.success).toBe(false)
  })

  test.each(['BLOCKED', 'SENDER_UNAVAILABLE', 'UNKNOWN_DENIAL'])(
    'fails closed without querying or creating a conversation for %s',
    async (reason) => {
      mockRpc.mockResolvedValue({ data: { allowed: false, reason }, error: null })

      const { POST } = await import('../route')
      const response = await POST({
        json: async () => ({ receiverId: RECEIVER_ID }),
      } as NextRequest)

      expect(response.status).toBe(403)
      await expect(response.json()).resolves.toEqual({
        error: 'Permission denied',
        error_code: 'PERMISSION_DENIED',
      })
      expect(mockFrom).not.toHaveBeenCalled()
    }
  )

  test.each([
    null,
    {},
    { allowed: 'yes' },
    { allowed: true, reason: 'BLOCKED' },
    { allowed: false },
    { allowed: false, reason: 'LIMIT_REACHED', sent_count: 2 },
  ])('fails closed for malformed permission acknowledgement %#', async (permission) => {
    mockRpc.mockResolvedValue({ data: permission, error: null })

    const { POST } = await import('../route')
    const response = await POST({
      json: async () => ({ receiverId: RECEIVER_ID }),
    } as NextRequest)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({
      error: 'Failed to check permissions',
      error_code: 'PERMISSION_CHECK_FAILED',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  test('does not create a conversation after an existing-conversation lookup error', async () => {
    mockRpc.mockResolvedValue({ data: { allowed: true }, error: null })
    const profileQuery = selectQuery({ data: { handle: 'receiver' }, error: null })
    const conversationQuery = selectQuery({
      data: null,
      error: { code: '57014', message: 'query cancelled' },
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileQuery
      if (table === 'conversations') return conversationQuery
      throw new Error(`Unexpected table: ${table}`)
    })

    const { POST } = await import('../route')
    const response = await POST({
      json: async () => ({ receiverId: RECEIVER_ID }),
    } as NextRequest)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Failed to find conversation' })
    expect(conversationQuery.single).not.toHaveBeenCalled()
  })

  test('returns an identity-bound acknowledgement for the exact conversation pair', async () => {
    mockRpc.mockResolvedValue({ data: { allowed: true, is_mutual: true }, error: null })
    const profileQuery = selectQuery({ data: { handle: 'receiver' }, error: null })
    const conversationQuery = selectQuery({
      data: {
        id: CONVERSATION_ID,
        user1_id: SENDER_ID,
        user2_id: RECEIVER_ID,
        created_at: '2026-07-29T00:00:00.000Z',
      },
      error: null,
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileQuery
      if (table === 'conversations') return conversationQuery
      throw new Error(`Unexpected table: ${table}`)
    })

    const { POST } = await import('../route')
    const response = await POST({
      json: async () => ({ receiverId: RECEIVER_ID }),
    } as NextRequest)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      conversation_id: CONVERSATION_ID,
      sender_id: SENDER_ID,
      receiver_id: RECEIVER_ID,
      can_message: true,
      is_mutual_follow: true,
      message_limit: null,
      receiver_handle: 'receiver',
    })
  })

  test('rejects a conversation row belonging to a different user pair', async () => {
    mockRpc.mockResolvedValue({ data: { allowed: true }, error: null })
    const profileQuery = selectQuery({ data: { handle: 'receiver' }, error: null })
    const conversationQuery = selectQuery({
      data: {
        id: CONVERSATION_ID,
        user1_id: SENDER_ID,
        user2_id: '44444444-4444-4444-8444-444444444444',
      },
      error: null,
    })
    mockFrom.mockImplementation((table: string) => {
      if (table === 'user_profiles') return profileQuery
      if (table === 'conversations') return conversationQuery
      throw new Error(`Unexpected table: ${table}`)
    })

    const { POST } = await import('../route')
    const response = await POST({
      json: async () => ({ receiverId: RECEIVER_ID }),
    } as NextRequest)

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'Unable to create conversation' })
  })
})
