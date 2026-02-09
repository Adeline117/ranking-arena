/**
 * Tests for GET /api/auth/siwe/nonce
 */

// Mock next/server NextResponse
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}))

// Mock next/headers cookies
const mockSet = jest.fn()
const mockCookies = jest.fn().mockResolvedValue({ set: mockSet })
jest.mock('next/headers', () => ({ cookies: () => mockCookies() }))

// Mock rate-limit (uses @upstash/redis which has ESM issues in Jest)
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { auth: {} },
}))

// Mock crypto.randomBytes to return a deterministic value for testing
const MOCK_HEX = 'a'.repeat(64)
jest.mock('crypto', () => ({
  randomBytes: jest.fn(() => ({ toString: () => MOCK_HEX })),
}))

import { GET } from '../route'

describe('GET /api/auth/siwe/nonce', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 200 with a nonce string', async () => {
    const response = await GET()
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(body).toHaveProperty('nonce')
    expect(typeof body.nonce).toBe('string')
  })

  it('returns a 64-character hex nonce', async () => {
    const response = await GET()
    const body = await response.json()

    expect(body.nonce).toMatch(/^[a-f0-9]{64}$/)
  })

  it('sets cookie with correct options', async () => {
    await GET()

    expect(mockSet).toHaveBeenCalledWith('siwe-nonce', MOCK_HEX, {
      httpOnly: true,
      secure: false, // NODE_ENV=test
      sameSite: 'lax',
      maxAge: 300,
      path: '/',
    })
  })
})
