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
    headers: HeaderBag
    cookies: { get: (name: string) => { value: string } | undefined }
    constructor(_url: string, init: { headers?: HeadersInit } = {}) {
      this.headers = new HeaderBag(init.headers)
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
const mockInvalidate = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: mockRpc, from: mockFrom }),
}))
jest.mock('@/lib/auth/extract-user', () => ({
  extractUserFromRequest: (...args: unknown[]) => mockExtractUser(...args),
}))
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockRateLimit(...args),
  RateLimitPresets: { write: { name: 'write' } },
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
jest.mock('@/app/api/following/route', () => ({
  invalidateFollowingCache: (...args: unknown[]) => mockInvalidate(...args),
}))
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextRequest, NextResponse } from 'next/server'
import { DELETE, POST } from '../route'

function successResult(
  overrides: Partial<{
    status: 'blocked' | 'already_blocked' | 'unblocked' | 'already_unblocked'
    actor_id: string
    target_id: string
    action: 'block' | 'unblock'
    changed: boolean
    blocked: boolean
    removed_outgoing_follow: boolean
    removed_incoming_follow: boolean
    actor_follower_count: number
    actor_following_count: number
    target_follower_count: number
    target_following_count: number
  }> = {}
) {
  return {
    status: 'blocked' as const,
    actor_id: ACTOR_ID,
    target_id: TARGET_ID,
    action: 'block' as const,
    changed: true,
    blocked: true,
    removed_outgoing_follow: true,
    removed_incoming_follow: true,
    actor_follower_count: 2,
    actor_following_count: 3,
    target_follower_count: 4,
    target_following_count: 5,
    ...overrides,
  }
}

function request() {
  return new NextRequest(`http://localhost/api/users/${TARGET_ID}/block`, {
    headers: { cookie: 'csrf-token=token', 'x-csrf-token': 'token' },
  })
}

function context(handle = TARGET_ID) {
  return { params: Promise.resolve({ handle }) }
}

describe('/api/users/[handle]/block atomic boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockExtractUser.mockResolvedValue({ user: { id: ACTOR_ID }, error: null })
    mockRateLimit.mockResolvedValue(null)
    mockFeatureGuard.mockReturnValue(null)
    mockValidateCsrf.mockReturnValue(true)
    mockInvalidate.mockResolvedValue(undefined)
    mockRpc.mockResolvedValue({ data: successResult(), error: null })
  })

  it('binds the verified actor to one atomic block RPC and invalidates both edge owners', async () => {
    const response = await POST(request(), context())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(mockRpc).toHaveBeenCalledTimes(1)
    expect(mockRpc).toHaveBeenCalledWith('mutate_user_block_atomic', {
      p_actor_id: ACTOR_ID,
      p_target_id: TARGET_ID,
      p_action: 'block',
    })
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidate).toHaveBeenCalledTimes(2)
    expect(mockInvalidate).toHaveBeenCalledWith(ACTOR_ID)
    expect(mockInvalidate).toHaveBeenCalledWith(TARGET_ID)
    expect(mockFireAndForget).toHaveBeenCalledTimes(1)
    expect(response.headers.get('cache-control')).toContain('no-store')
  })

  it('preserves the duplicate-block compatibility response', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({
        status: 'already_blocked',
        changed: false,
        removed_outgoing_follow: false,
        removed_incoming_follow: false,
      }),
      error: null,
    })
    const response = await POST(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, alreadyBlocked: true })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    [
      successResult({
        status: 'unblocked',
        action: 'unblock',
        blocked: false,
        removed_outgoing_follow: false,
        removed_incoming_follow: false,
      }),
    ],
    [
      successResult({
        status: 'already_unblocked',
        action: 'unblock',
        changed: false,
        blocked: false,
        removed_outgoing_follow: false,
        removed_incoming_follow: false,
      }),
    ],
  ])('uses the same atomic boundary for unblock retry %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })
    const response = await DELETE(request(), context())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true })
    expect(mockRpc).toHaveBeenCalledWith('mutate_user_block_atomic', {
      p_actor_id: ACTOR_ID,
      p_target_id: TARGET_ID,
      p_action: 'unblock',
    })
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    ['invalid', 400],
    ['self', 400],
    ['actor_unavailable', 403],
    ['target_unavailable', 404],
  ])('maps canonical %s without a table fallback', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(expectedStatus)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it.each([
    null,
    [],
    {},
    { status: 'unknown' },
    successResult({ actor_id: TARGET_ID }),
    successResult({ target_id: ACTOR_ID }),
    successResult({ action: 'unblock' }),
    successResult({ blocked: false }),
    successResult({ changed: false }),
    successResult({ actor_follower_count: -1 }),
    { ...successResult(), forged: true },
  ])('fails closed on malformed or inconsistent block ACK %#', async (data) => {
    mockRpc.mockResolvedValue({ data, error: null })
    const response = await POST(request(), context())
    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it('rejects an unblock ACK that claims follow removal', async () => {
    mockRpc.mockResolvedValue({
      data: successResult({
        status: 'unblocked',
        action: 'unblock',
        blocked: false,
        removed_outgoing_follow: true,
        removed_incoming_follow: false,
      }),
      error: null,
    })
    const response = await DELETE(request(), context())
    expect(response.status).toBe(500)
    expect(mockInvalidate).not.toHaveBeenCalled()
  })

  it('strictly validates the target UUID before the RPC', async () => {
    const response = await POST(request(), context('not-a-uuid'))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects self block before the RPC', async () => {
    const response = await POST(request(), context(ACTOR_ID))
    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires CSRF for both state-changing methods', async () => {
    mockValidateCsrf.mockReturnValue(false)
    const [postResponse, deleteResponse] = await Promise.all([
      POST(request(), context()),
      DELETE(request(), context()),
    ])
    expect(postResponse.status).toBe(403)
    expect(deleteResponse.status).toBe(403)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the atomic block RPC errors', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { message: 'database failed' } })
    const response = await POST(request(), context())
    expect(response.status).toBe(500)
    expect(mockFrom).not.toHaveBeenCalled()
  })

  it('honors the feature guard before authentication', async () => {
    const guarded = NextResponse.json({ error: 'disabled' }, { status: 503 })
    mockFeatureGuard.mockReturnValue(guarded)
    const response = await POST(request(), context())
    expect(response).toBe(guarded)
    expect(mockExtractUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })
})
