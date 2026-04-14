/**
 * Service Auth verification tests
 *
 * Tests verifyCronSecret, verifyServiceAuth, and verifyAdminAuth
 * with mocked env and Supabase dependencies.
 */

// Mock @/lib/env before importing the module under test
jest.mock('@/lib/env', () => ({
  env: {
    CRON_SECRET: 'test-cron-secret-123',
  },
}))

// Mock @/lib/supabase/server — returns a controllable mock client
const mockGetUser = jest.fn()
const mockMaybeSingle = jest.fn()
const mockSupabaseAdmin = {
  auth: { getUser: mockGetUser },
  from: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      eq: jest.fn().mockReturnValue({
        maybeSingle: mockMaybeSingle,
      }),
    }),
  }),
}
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => mockSupabaseAdmin),
}))

import {
  verifyCronSecret,
  verifyServiceAuth,
  verifyAdminAuth,
} from '../verify-service-auth'

// Helper to create a Request with specific headers
function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request('https://example.com/api/test', { headers })
}

beforeEach(() => {
  jest.clearAllMocks()
  // Reset INTERNAL_API_KEY for each test
  delete process.env.INTERNAL_API_KEY
})

// ============================================
// verifyCronSecret
// ============================================

describe('verifyCronSecret', () => {
  test('valid Bearer token returns true', () => {
    const req = makeRequest({ authorization: 'Bearer test-cron-secret-123' })
    expect(verifyCronSecret(req)).toBe(true)
  })

  test('missing authorization header returns false', () => {
    const req = makeRequest()
    expect(verifyCronSecret(req)).toBe(false)
  })

  test('wrong secret returns false', () => {
    const req = makeRequest({ authorization: 'Bearer wrong-secret' })
    expect(verifyCronSecret(req)).toBe(false)
  })

  test('missing Bearer prefix returns false', () => {
    const req = makeRequest({ authorization: 'test-cron-secret-123' })
    expect(verifyCronSecret(req)).toBe(false)
  })

  test('empty CRON_SECRET env returns false', () => {
    // Temporarily override env mock
    const { env } = jest.requireMock('@/lib/env') as { env: { CRON_SECRET: string | undefined } }
    const original = env.CRON_SECRET
    env.CRON_SECRET = undefined as unknown as string
    try {
      const req = makeRequest({ authorization: 'Bearer anything' })
      expect(verifyCronSecret(req)).toBe(false)
    } finally {
      env.CRON_SECRET = original
    }
  })

  test('extra whitespace in token returns false', () => {
    const req = makeRequest({ authorization: 'Bearer  test-cron-secret-123' })
    expect(verifyCronSecret(req)).toBe(false)
  })
})

// ============================================
// verifyServiceAuth
// ============================================

describe('verifyServiceAuth', () => {
  test('valid cron secret returns true', () => {
    const req = makeRequest({ authorization: 'Bearer test-cron-secret-123' })
    expect(verifyServiceAuth(req)).toBe(true)
  })

  test('valid internal API key returns true', () => {
    process.env.INTERNAL_API_KEY = 'internal-key-456'
    const req = makeRequest({ 'x-internal-key': 'internal-key-456' })
    expect(verifyServiceAuth(req)).toBe(true)
  })

  test('both missing returns false', () => {
    const req = makeRequest()
    expect(verifyServiceAuth(req)).toBe(false)
  })

  test('wrong internal API key returns false', () => {
    process.env.INTERNAL_API_KEY = 'internal-key-456'
    const req = makeRequest({ 'x-internal-key': 'wrong-key' })
    expect(verifyServiceAuth(req)).toBe(false)
  })

  test('no INTERNAL_API_KEY configured, only internal header provided, returns false', () => {
    // INTERNAL_API_KEY not set in env
    const req = makeRequest({ 'x-internal-key': 'some-key' })
    expect(verifyServiceAuth(req)).toBe(false)
  })
})

// ============================================
// verifyAdminAuth
// ============================================

describe('verifyAdminAuth', () => {
  test('valid cron secret returns true', async () => {
    const req = makeRequest({ authorization: 'Bearer test-cron-secret-123' })
    expect(await verifyAdminAuth(req)).toBe(true)
  })

  test('valid x-admin-token returns true', async () => {
    const req = makeRequest({ 'x-admin-token': 'test-cron-secret-123' })
    expect(await verifyAdminAuth(req)).toBe(true)
  })

  test('valid admin JWT returns true', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValueOnce({
      data: { role: 'admin' },
      error: null,
    })

    const req = makeRequest({ authorization: 'Bearer valid-admin-jwt-token' })
    expect(await verifyAdminAuth(req)).toBe(true)
  })

  test('non-admin JWT returns false', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: 'user-1' } },
      error: null,
    })
    mockMaybeSingle.mockResolvedValueOnce({
      data: { role: 'user' },
      error: null,
    })

    const req = makeRequest({ authorization: 'Bearer valid-user-jwt-token' })
    expect(await verifyAdminAuth(req)).toBe(false)
  })

  test('invalid JWT (getUser error) returns false', async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: new Error('Invalid JWT'),
    })

    const req = makeRequest({ authorization: 'Bearer invalid-jwt' })
    expect(await verifyAdminAuth(req)).toBe(false)
  })

  test('no auth header at all returns false', async () => {
    const req = makeRequest()
    expect(await verifyAdminAuth(req)).toBe(false)
  })
})
