/**
 * /api/settings/2fa/setup route tests
 *
 * Tests authentication, 2FA already-enabled guard, TOTP secret generation,
 * QR code data, and error handling for the 2FA setup API.
 */

// --- Mocks (must be before imports) ---

jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>
    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status || 200
      this.headers = new Map()
    }
    async json() { return this._body }
    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    headers: Map<string, string>
    method: string
    _body: unknown
    constructor(url: string, opts?: { headers?: Record<string, string>; method?: string; body?: unknown }) {
      this.url = url
      this.nextUrl = new URL(url)
      this.headers = new Map(Object.entries({ 'user-agent': 'Mozilla/5.0 (Jest Test Runner)', ...opts?.headers }))
      this.method = opts?.method || 'POST'
      this._body = opts?.body
    }
    async json() { return this._body }
  }

  return { NextResponse: MockNextResponse, NextRequest: MockNextRequest }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  checkRateLimitFull: jest.fn().mockResolvedValue({ response: null, meta: null }),
  addRateLimitHeaders: jest.fn(),
  RateLimitPresets: { read: {}, write: {}, public: {}, sensitive: {}, authenticated: {} },
}))

const mockGetAuthUser = jest.fn()

// Supabase mock: supports chained .from().select().eq().single() and .from().upsert()
const mockProfileResult = { data: { totp_enabled: false }, error: null }
const mockUpsertResult = { error: null }

const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table === 'user_profiles') {
      return {
        select: jest.fn().mockReturnValue({
          eq: jest.fn().mockReturnValue({
            single: jest.fn().mockResolvedValue(mockProfileResult),
          }),
        }),
      }
    }
    if (table === 'user_2fa_secrets') {
      return {
        upsert: jest.fn().mockResolvedValue(mockUpsertResult),
      }
    }
    return {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      upsert: jest.fn().mockResolvedValue({ error: null }),
    }
  }),
}

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function, _opts?: unknown) => async (req: unknown) => {
    const user = await mockGetAuthUser(req)
    if (!user) {
      const { NextResponse: NR } = require('next/server') // eslint-disable-line @typescript-eslint/no-require-imports
      return NR.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }
    return handler({ user, supabase: mockSupabase, request: req, version: { current: 'v1' } })
  },
  withPublic: (handler: Function) => handler,
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabase),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

const mockGenerateTotpSecret = jest.fn()
jest.mock('@/lib/services/totp', () => ({
  generateTotpSecret: (...args: unknown[]) => mockGenerateTotpSecret(...args),
}))

const mockToDataURL = jest.fn()
jest.mock('qrcode', () => ({
  toDataURL: (...args: unknown[]) => mockToDataURL(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() })),
  fireAndForget: jest.fn(),
}))

jest.mock('@/lib/api/versioning', () => ({
  parseApiVersion: jest.fn().mockReturnValue({ version: 'v1', deprecated: false }),
  addVersionHeaders: jest.fn(),
  addDeprecationHeaders: jest.fn(),
}))

jest.mock('@/lib/api/correlation', () => ({
  getOrCreateCorrelationId: jest.fn().mockReturnValue('test-cid'),
  runWithCorrelationId: jest.fn((_id: string, fn: () => unknown) => fn()),
}))

jest.mock('@/lib/utils/csrf', () => ({
  validateCsrfToken: jest.fn().mockReturnValue(true),
  CSRF_COOKIE_NAME: 'csrf',
  CSRF_HEADER_NAME: 'x-csrf-token',
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

describe('POST /api/settings/2fa/setup', () => {
  const mockUser = { id: 'user-123', email: 'test@test.com' }

  beforeEach(() => {
    jest.clearAllMocks()
    mockGetAuthUser.mockResolvedValue(mockUser)
    mockGenerateTotpSecret.mockReturnValue({
      secret: 'JBSWY3DPEHPK3PXP',
      uri: 'otpauth://totp/RankingArena:test@test.com?secret=JBSWY3DPEHPK3PXP&issuer=RankingArena',
    })
    mockToDataURL.mockResolvedValue('data:image/png;base64,iVBORw0KGgoAAAA...')
    // Reset Supabase mock results
    mockProfileResult.data = { totp_enabled: false }
    mockProfileResult.error = null
    mockUpsertResult.error = null
  })

  // --- Authentication ---

  it('returns 401 when not authenticated', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(401)
    expect(body.error).toBeDefined()
  })

  // --- Already Enabled Guard ---

  it('returns 400 when 2FA is already enabled', async () => {
    mockProfileResult.data = { totp_enabled: true }

    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(400)
    expect(body.error?.message ?? body.error).toMatch(/already enabled/i)
  })

  // --- Success Case ---

  it('generates TOTP secret and returns QR code data', async () => {
    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body.secret).toBe('JBSWY3DPEHPK3PXP')
    expect(body.uri).toContain('otpauth://totp/')
    expect(body.qrCode).toContain('data:image/png')
    expect(mockGenerateTotpSecret).toHaveBeenCalledWith('test@test.com')
    expect(mockToDataURL).toHaveBeenCalledWith(
      expect.stringContaining('otpauth://totp/')
    )
  })

  it('uses user.id as label when email is not available', async () => {
    mockGetAuthUser.mockResolvedValue({ id: 'user-456', email: undefined })

    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    await POST(req)

    expect(mockGenerateTotpSecret).toHaveBeenCalledWith('user-456')
  })

  it('stores TOTP secret in user_2fa_secrets table', async () => {
    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    const res = await POST(req)

    expect(res.status).toBe(200)
    expect(mockSupabase.from).toHaveBeenCalledWith('user_2fa_secrets')
  })

  // --- Error Handling ---

  it('returns 500 when profile fetch fails', async () => {
    mockProfileResult.data = null
    mockProfileResult.error = { message: 'DB error', code: '500' }

    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error?.message ?? body.error).toMatch(/Failed to fetch|server/i)
  })

  it('returns 500 when secret storage fails', async () => {
    mockUpsertResult.error = { message: 'Insert error', code: '500' }

    const req = new NextRequest('http://localhost/api/settings/2fa/setup', {
      method: 'POST',
    })
    const res = await POST(req)
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body.error?.message ?? body.error).toMatch(/Failed to store|server/i)
  })
})
