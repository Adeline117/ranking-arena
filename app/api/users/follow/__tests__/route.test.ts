jest.mock('next/server', () => {
  class HeaderBag {
    private values = new Map<string, string>()

    constructor(initial?: HeadersInit) {
      if (initial) {
        for (const [name, value] of Object.entries(initial as Record<string, string>)) {
          this.set(name, value)
        }
      }
    }

    get(name: string) {
      return this.values.get(name.toLowerCase()) ?? null
    }

    set(name: string, value: string) {
      this.values.set(name.toLowerCase(), String(value))
    }
  }

  class MockNextResponse {
    private body: unknown
    status: number
    headers: HeaderBag

    constructor(body: unknown, init: { status?: number; headers?: HeadersInit } = {}) {
      this.body = body
      this.status = init.status ?? 200
      this.headers = new HeaderBag(init.headers)
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    nextUrl: URL
    headers: HeaderBag
    cookies: { get: (name: string) => { value: string } | undefined }
    private body: string | undefined

    constructor(url: string, init: { headers?: HeadersInit; body?: string } = {}) {
      this.nextUrl = new URL(url)
      this.headers = new HeaderBag(init.headers)
      this.body = init.body
      this.cookies = {
        get: (name: string) => {
          const cookie = this.headers.get('cookie')
          const match = cookie
            ?.split(';')
            .map((part) => part.trim().split('='))
            .find(([key]) => key === name)
          return match ? { value: match.slice(1).join('=') } : undefined
        },
      }
    }

    async json() {
      return JSON.parse(this.body ?? '')
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const ACTOR_ID = '11111111-1111-4111-8111-111111111111'
const TARGET_ID = '22222222-2222-4222-8222-222222222222'

const mockRpc = jest.fn()
const mockFrom = jest.fn()
const mockExtractUser = jest.fn()
const mockRateLimit = jest.fn()
const mockFeatureGuard = jest.fn()
const mockValidateCsrf = jest.fn()
const mockFireAndForget = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
}))
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  RateLimitPresets: { authenticated: { name: 'authenticated' }, write: { name: 'write' } },
}))
jest.mock('@/lib/features', () => ({ socialFeatureGuard: () => mockFeatureGuard() }))
jest.mock('@/lib/utils/csrf', () => ({
  CSRF_COOKIE_NAME: 'csrf-token',
  CSRF_HEADER_NAME: 'x-csrf-token',
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrf(...args),
}))
jest.mock('@/lib/utils/logger', () => ({
  fireAndForget: (...args: unknown[]) => mockFireAndForget(...args),
}))
jest.mock('@/lib/data/notifications', () => ({ sendNotification: jest.fn() }))
jest.mock('@/app/api/following/route', () => ({
  invalidateFollowingCache: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest, NextResponse } from 'next/server'
import { GET, POST } from '../route'

function successResult(
  overrides: Partial<{
    status: 'followed' | 'already_following' | 'unfollowed' | 'already_not_following'
    actor_id: string
    target_id: string
    action: 'follow' | 'unfollow'
    changed: boolean
    following: boolean
    followed_by: boolean
    mutual: boolean
    actor_follower_count: number
    actor_following_count: number
    target_follower_count: number
    target_following_count: number
  }> = {}
) {
  return {
    status: 'followed' as const,
    actor_id: ACTOR_ID,
    target_id: TARGET_ID,
    action: 'follow' as const,
    changed: true,
    following: true,
    followed_by: true,
    mutual: true,
    actor_follower_count: 3,
    actor_following_count: 4,
    target_follower_count: 5,
    target_following_count: 6,
    ...overrides,
  }
}

function postRequest(body: unknown = { followingId: TARGET_ID, action: 'follow' }) {
  return new NextRequest('http://localhost/api/users/follow', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: 'csrf-token=token',
      'x-csrf-token': 'token',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

function query(result: { data: unknown; error: null | { message: string } }) {
  const chain = {
    select: jest.fn(),
    eq: jest.fn(),
    maybeSingle: jest.fn().mockResolvedValue(result),
  }
  chain.select.mockReturnValue(chain)
  chain.eq.mockReturnValue(chain)
  return chain
}

describe('/api/users/follow atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExtractUser.mockResolvedValue({ user: { id: ACTOR_ID }, error: null })
    mockRateLimit.mockResolvedValue(null)
    mockFeatureGuard.mockReturnValue(null)
    mockValidateCsrf.mockReturnValue(true)
    mockRpc.mockResolvedValue({ data: successResult(), error: null })
  })

  it('binds the verified actor to one strict follow RPC and returns absolute counts', async () => {
    const response = await POST(postRequest())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      success: true,
      following: true,
      followedBy: true,
      mutual: true,
      followerCount: 5,
      followingCount: 4,
    })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('mutate_user_follow_atomic', {
      p_actor_id: ACTOR_ID,
      p_target_id: TARGET_ID,
      p_action: 'follow',
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockFrom).not.toHaveBeenCalledWith('user_follows')
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it.each([
    [
      { followingId: TARGET_ID, action: 'follow' },
      successResult({ status: 'already_following', changed: false }),
      true,
    ],
    [
      { followingId: TARGET_ID, action: 'unfollow' },
      successResult({
        status: 'unfollowed',
        action: 'unfollow',
        following: false,
        mutual: false,
      }),
      false,
    ],
    [
      { followingId: TARGET_ID, action: 'unfollow' },
      successResult({
        status: 'already_not_following',
        action: 'unfollow',
        changed: false,
        following: false,
        mutual: false,
      }),
      false,
    ],
  ])('accepts idempotent canonical result %#', async (body, data, following) => {
    mockRpc.mockResolvedValue({ data, error: null })
    const response = await POST(postRequest(body))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ success: true, following })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('queues a notification only for a newly inserted follow edge', async () => {
    await POST(postRequest())
    expect(mockFireAndForget).toHaveBeenCalledTimes(2)

    jest.clearAllMocks()
    mockExtractUser.mockResolvedValue({ user: { id: ACTOR_ID }, error: null })
    mockRateLimit.mockResolvedValue(null)
    mockFeatureGuard.mockReturnValue(null)
    mockValidateCsrf.mockReturnValue(true)
    mockRpc.mockResolvedValue({
      data: successResult({ status: 'already_following', changed: false }),
      error: null,
    })
    await POST(postRequest())
    expect(mockFireAndForget).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    { followingId: 'not-a-uuid', action: 'follow' },
    { followingId: TARGET_ID, action: 'toggle' },
    { followingId: TARGET_ID, action: 'follow', actorId: TARGET_ID },
  ])('rejects malformed or overposted mutation input %#', async (body) => {
    const response = await POST(postRequest(body))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects self-follow before database work', async () => {
    const response = await POST(postRequest({ followingId: ACTOR_ID, action: 'follow' }))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires CSRF before parsing or mutating', async () => {
    mockValidateCsrf.mockReturnValue(false)
    const response = await POST(postRequest('not json'))
    expect(response.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 400],
    ['self', 400],
    ['actor_unavailable', 403],
    ['target_unavailable', 404],
    ['blocked', 403],
  ])('maps canonical %s failure without direct DML', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })
    const response = await POST(postRequest())
    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    {},
    { status: 'unknown' },
    successResult({ actor_id: TARGET_ID }),
    successResult({ action: 'unfollow' }),
    successResult({ following: false }),
    successResult({ mutual: false }),
    successResult({ target_follower_count: -1 }),
    { ...successResult(), forged: true },
  ])('fails closed on malformed or inconsistent RPC result %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })
    const response = await POST(postRequest())
    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic RPC fails', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database failed' } })
    const response = await POST(postRequest())
    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('honors the feature guard before authentication or mutation', async () => {
    const guarded = NextResponse.json({ error: 'disabled' }, { status: 503 })
    mockFeatureGuard.mockReturnValue(guarded)
    const response = await POST(postRequest())
    expect(response).toBe(guarded)
    expect(mockExtractUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('returns a current relationship only for an active target', async () => {
    mockFrom
      .mockReturnValueOnce(
        query({
          data: {
            id: TARGET_ID,
            handle: 'target',
            deleted_at: null,
            banned_at: null,
            is_banned: false,
            ban_expires_at: null,
          },
          error: null,
        })
      )
      .mockReturnValueOnce(query({ data: { id: 'edge-1' }, error: null }))
      .mockReturnValueOnce(query({ data: { id: 'edge-2' }, error: null }))

    const response = await GET(
      new NextRequest(`http://localhost/api/users/follow?followingId=${TARGET_ID}`)
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ following: true, followedBy: true, mutual: true })
  })

  it('fails the relationship read closed when either direction errors', async () => {
    mockFrom
      .mockReturnValueOnce(
        query({
          data: {
            id: TARGET_ID,
            handle: 'target',
            deleted_at: null,
            banned_at: null,
            is_banned: false,
            ban_expires_at: null,
          },
          error: null,
        })
      )
      .mockReturnValueOnce(query({ data: null, error: null }))
      .mockReturnValueOnce(query({ data: null, error: { message: 'reverse read failed' } }))

    const response = await GET(
      new NextRequest(`http://localhost/api/users/follow?followingId=${TARGET_ID}`)
    )
    expect(response.status).toBe(500)
  })

  it('strictly rejects extra or invalid relationship query parameters', async () => {
    const response = await GET(
      new NextRequest(
        `http://localhost/api/users/follow?followingId=${TARGET_ID}&actorId=${TARGET_ID}`
      )
    )
    expect(response.status).toBe(400)
    expect(mockFrom).not.toHaveBeenCalled()
  })
})
