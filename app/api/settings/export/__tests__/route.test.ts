jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Map(Object.entries(init.headers ?? {}))
    }
    async json() {
      return typeof this._body === 'string' ? JSON.parse(this._body) : this._body
    }
    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

const mockGetProvisioningAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockValidateCsrfToken = jest.fn()
const mockFetchAllExportRows = jest.fn()
const mockFrom = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getProvisioningAuthUser: (...args: unknown[]) => mockGetProvisioningAuthUser(...args),
  getSupabaseAdmin: (...args: unknown[]) => mockGetSupabaseAdmin(...args),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { write: { name: 'write-test-policy' } },
}))

jest.mock('@/lib/utils/csrf', () => ({
  CSRF_COOKIE_NAME: 'csrf-cookie',
  CSRF_HEADER_NAME: 'x-csrf-token',
  validateCsrfToken: (...args: unknown[]) => mockValidateCsrfToken(...args),
}))

jest.mock('@/lib/account/data-export', () => {
  const actual = jest.requireActual('@/lib/account/data-export')
  return {
    ...actual,
    fetchAllExportRows: (...args: unknown[]) => mockFetchAllExportRows(...args),
  }
})

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { NextResponse } from 'next/server'
import { DataExportReadError, DataExportTooLargeError } from '@/lib/account/data-export'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PROFILE = {
  id: USER_ID,
  handle: 'viewer',
  avatar_url: null,
  bio: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: null,
  last_export_at: null,
}

type QueryState = { operation: 'read' | 'update'; selection: string | null }

function request() {
  return {
    cookies: { get: () => ({ value: 'csrf-value' }) },
    headers: { get: () => 'csrf-value' },
  } as never
}

function installProfileQueries(options: {
  profile?: typeof PROFILE | null
  profileError?: unknown
  claim?: 'success' | 'lost' | 'error'
  currentLastExportAt?: string | null
}) {
  const claimMode = options.claim ?? 'success'
  const states: QueryState[] = []
  mockFrom.mockImplementation((table: string) => {
    expect(table).toBe('user_profiles')
    const state: QueryState = { operation: 'read', selection: null }
    states.push(state)
    const query = {
      select: jest.fn((selection: string) => {
        state.selection = selection
        return query
      }),
      update: jest.fn(() => {
        state.operation = 'update'
        return query
      }),
      eq: jest.fn(() => query),
      or: jest.fn(() => query),
      maybeSingle: jest.fn(async () => {
        if (state.operation === 'update') {
          if (claimMode === 'error') {
            return { data: null, error: { code: 'XX002', message: 'claim failed' } }
          }
          return {
            data: claimMode === 'success' ? { id: USER_ID } : null,
            error: null,
          }
        }
        if (state.selection === 'last_export_at') {
          return {
            data: { last_export_at: options.currentLastExportAt ?? new Date().toISOString() },
            error: null,
          }
        }
        return {
          data: options.profile === undefined ? PROFILE : options.profile,
          error: options.profileError ?? null,
        }
      }),
    }
    return query
  })
  return states
}

describe('POST /api/settings/export', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetProvisioningAuthUser.mockResolvedValue({ id: USER_ID })
    mockValidateCsrfToken.mockReturnValue(true)
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
    mockFetchAllExportRows.mockImplementation(async (_client, dataset) => [
      { id: `${dataset.name}-1` },
    ])
    installProfileQueries({})
  })

  it('returns only after every complete dataset is assembled and the cooldown is claimed', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body.profile).toEqual({
      id: USER_ID,
      handle: 'viewer',
      avatar_url: null,
      bio: null,
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: null,
    })
    expect(body.posts).toEqual([{ id: 'posts-1' }])
    expect(body.comments).toEqual([{ id: 'comments-1' }])
    expect(body.follows.following).toEqual([{ id: 'following-1' }])
    expect(body.follows.followers).toEqual([{ id: 'followers-1' }])
    expect(body.tips.sent).toEqual([{ id: 'tips.sent-1' }])
    expect(body.tips.received).toEqual([{ id: 'tips.received-1' }])
    expect(mockFetchAllExportRows).toHaveBeenCalledTimes(6)
    expect(mockFrom).toHaveBeenCalledTimes(2)
    expect(response.headers.get('Content-Disposition')).toContain(USER_ID)
  })

  it('fails closed without consuming cooldown when one dataset page fails', async () => {
    mockFetchAllExportRows.mockRejectedValueOnce(
      new DataExportReadError('comments', { code: 'XX001' })
    )

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).toEqual({ error: 'Failed to prepare a complete export' })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('returns an explicit 413 without cooldown when the full export is too large', async () => {
    mockFetchAllExportRows.mockRejectedValueOnce(new DataExportTooLargeError('posts'))

    const response = await POST(request())

    expect(response.status).toBe(413)
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('fails closed when the provisioned profile row is missing', async () => {
    installProfileQueries({ profile: null })

    const response = await POST(request())

    expect(response.status).toBe(503)
    expect(mockFetchAllExportRows).not.toHaveBeenCalled()
  })

  it('honors an existing durable cooldown before reading export datasets', async () => {
    installProfileQueries({
      profile: { ...PROFILE, last_export_at: new Date().toISOString() },
    })

    const response = await POST(request())

    expect(response.status).toBe(429)
    expect(mockFetchAllExportRows).not.toHaveBeenCalled()
  })

  it('lets only the conditional-update winner return a concurrent download', async () => {
    const winnerStates = installProfileQueries({ claim: 'success' })
    const winner = await POST(request())
    expect(winner.status).toBe(200)
    expect(winnerStates.some((state) => state.operation === 'update')).toBe(true)

    const lastExportAt = new Date().toISOString()
    installProfileQueries({ claim: 'lost', currentLastExportAt: lastExportAt })
    const loser = await POST(request())

    expect(loser.status).toBe(429)
    expect((await loser.json()).error).toContain(
      new Date(new Date(lastExportAt).getTime() + 24 * 60 * 60 * 1000).toISOString()
    )
  })

  it('does not return a download when the atomic cooldown claim errors', async () => {
    installProfileQueries({ claim: 'error' })

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it('stops before authentication/admin work when the route limiter responds', async () => {
    const limited = NextResponse.json({ error: 'Too many requests' }, { status: 429 })
    mockCheckRateLimit.mockResolvedValue(limited)

    const response = await POST(request())

    expect(response).toBe(limited)
    expect(mockGetProvisioningAuthUser).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })
})
