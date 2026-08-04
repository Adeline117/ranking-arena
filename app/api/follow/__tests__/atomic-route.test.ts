/** @jest-environment node */
// Atomic authority contract tests; legacy route coverage remains in route.test.ts.

const USER_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222'
const TRADER_ID = 'leader-123'
const SOURCE = 'bybit'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockInvalidateFollowingCache = jest.fn()
const mockSendNotification = jest.fn()
const mockFireAndForget = jest.fn()

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
        user: { id: USER_ID },
        supabase: { rpc: mockRpc, from: mockFrom },
        request,
      }),
}))

jest.mock('@/lib/api/response', () => {
  const response = (message: string, status: number) => {
    const { NextResponse } = require('next/server')
    return NextResponse.json({ error: message }, { status })
  }
  return {
    success: (data: unknown) => data,
    badRequest: (message: string) => response(message, 400),
    serverError: (message: string) => response(message, 500),
  }
})

jest.mock('@/lib/types/premium', () => ({
  PRO_FREE_PROMO: false,
  getFeatureLimits: (tier: string) => ({ followLimit: tier === 'pro' ? 100 : 10 }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/app/api/following/route', () => ({
  invalidateFollowingCache: (...args: unknown[]) => mockInvalidateFollowingCache(...args),
}))

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { POST } from '../route'

function request(body: Record<string, unknown>) {
  return { json: jest.fn().mockResolvedValue(body) } as never
}

function followAck(
  status: 'followed' | 'already_following' | 'limit_reached' = 'followed',
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    user_id: USER_ID,
    trader_id: TRADER_ID,
    source: SOURCE,
    following: status !== 'limit_reached',
    current_count: status === 'limit_reached' ? 10 : 1,
    limit: 10,
    ...overrides,
  }
}

function unfollowAck(
  status: 'unfollowed' | 'not_following' = 'unfollowed',
  source: string | null = SOURCE,
  overrides: Record<string, unknown> = {}
) {
  return {
    status,
    user_id: USER_ID,
    trader_id: TRADER_ID,
    source,
    following: false,
    ...overrides,
  }
}

describe('POST /api/follow atomic limit authority', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue({ data: followAck(), error: null })
    mockInvalidateFollowingCache.mockResolvedValue(undefined)
    mockFrom.mockImplementation((table: string) => {
      if (table !== 'verified_traders') {
        throw new Error(`Unexpected direct table access: ${table}`)
      }
      return {
        select: jest.fn(() => ({
          eq: jest.fn(() => ({
            eq: jest.fn(() => ({
              maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
            })),
          })),
        })),
      }
    })
  })

  it('follows only through the atomic RPC with server-owned limits', async () => {
    const response = await POST(
      request({ traderId: `  ${TRADER_ID}  `, source: ` ${SOURCE} `, action: 'follow' })
    )

    expect(response).toEqual({ following: true, traderId: TRADER_ID, source: SOURCE })
    expect(mockRpc).toHaveBeenCalledWith('mutate_trader_follow_atomic', {
      p_actor_id: USER_ID,
      p_trader_id: TRADER_ID,
      p_source: SOURCE,
      p_action: 'follow',
      p_promo_unlocked: false,
      p_free_limit: 10,
      p_pro_limit: 100,
    })
    expect(mockInvalidateFollowingCache).toHaveBeenCalledWith(USER_ID)
    expect(mockFireAndForget).toHaveBeenCalledTimes(2)
  })

  it('replays an existing follow without duplicate cache or notification work', async () => {
    mockRpc.mockResolvedValue({ data: followAck('already_following'), error: null })

    const response = await POST(request({ traderId: TRADER_ID, source: SOURCE, action: 'follow' }))

    expect(response).toEqual({ following: true, traderId: TRADER_ID, source: SOURCE })
    expect(mockInvalidateFollowingCache).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it('returns the authoritative limit without attempting a table fallback', async () => {
    mockRpc.mockResolvedValue({ data: followAck('limit_reached'), error: null })

    const response = await POST(request({ traderId: TRADER_ID, source: SOURCE, action: 'follow' }))

    expect(response.status).toBe(429)
    await expect(response.json()).resolves.toEqual({
      error: 'Follow limit reached (10). Upgrade to Pro for more.',
      code: 'FOLLOW_LIMIT',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateFollowingCache).not.toHaveBeenCalled()
  })

  it('supports an exact legacy null-source unfollow through the authority', async () => {
    mockRpc.mockResolvedValue({ data: unfollowAck('unfollowed', null), error: null })

    const response = await POST(request({ traderId: TRADER_ID, source: null, action: 'unfollow' }))

    expect(response).toEqual({ following: false, traderId: TRADER_ID, source: null })
    expect(mockRpc).toHaveBeenCalledWith(
      'mutate_trader_follow_atomic',
      expect.objectContaining({
        p_action: 'unfollow',
        p_source: null,
      })
    )
    expect(mockInvalidateFollowingCache).toHaveBeenCalledWith(USER_ID)
  })

  it('replays a missing unfollow without false mutation side effects', async () => {
    mockRpc.mockResolvedValue({ data: unfollowAck('not_following'), error: null })

    const response = await POST(
      request({ traderId: TRADER_ID, source: SOURCE, action: 'unfollow' })
    )

    expect(response).toEqual({ following: false, traderId: TRADER_ID, source: SOURCE })
    expect(mockInvalidateFollowingCache).not.toHaveBeenCalled()
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'failed' } }],
    ['null ACK', { data: null, error: null }],
    ['unknown ACK', { data: { status: 'ok' }, error: null }],
    ['wrong owner', { data: followAck('followed', { user_id: OTHER_USER_ID }), error: null }],
    ['wrong trader', { data: followAck('followed', { trader_id: 'other' }), error: null }],
    ['wrong source', { data: followAck('followed', { source: 'okx' }), error: null }],
    [
      'contradictory count',
      { data: followAck('limit_reached', { current_count: 9 }), error: null },
    ],
    ['unexpected field', { data: followAck('followed', { legacy: true }), error: null }],
    ['wrong action', { data: unfollowAck('unfollowed'), error: null }],
  ])('fails closed on a %s without direct mutation fallback', async (_label, result) => {
    mockRpc.mockResolvedValue(result)

    const response = await POST(request({ traderId: TRADER_ID, source: SOURCE, action: 'follow' }))

    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidateFollowingCache).not.toHaveBeenCalled()
  })

  it('rejects an inactive account exactly', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'account_inactive' }, error: null })

    const response = await POST(request({ traderId: TRADER_ID, source: SOURCE, action: 'follow' }))

    expect(response.status).toBe(403)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    { traderId: 'x'.repeat(256), source: SOURCE, action: 'follow' },
    { traderId: TRADER_ID, source: 'bad\u0000source', action: 'follow' },
    { traderId: TRADER_ID, source: null, action: 'follow' },
    { traderId: TRADER_ID, source: SOURCE, action: 'follow', unexpected: true },
    { traderId: TRADER_ID, source: SOURCE, action: 'unfollow', unexpected: true },
  ])('rejects malformed identity input before the RPC', async (body) => {
    await expect(POST(request(body))).rejects.toThrow('Invalid input')
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('contains no direct trader-follow count or mutation fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/follow/route.ts'), 'utf8')
    const post = source.slice(source.indexOf('export const POST'))

    expect(post).toContain("'mutate_trader_follow_atomic'")
    expect(post).not.toContain(".from('trader_follows')")
    expect(post).not.toContain(".from('subscriptions')")
    expect(post).not.toContain('.insert(')
    expect(post).not.toContain('.delete(')
    expect(post).not.toContain('.update(')
  })
})
