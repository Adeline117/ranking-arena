/**
 * Tests for POST /api/auth/siwe/verify
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

// Mock rate-limit (uses @upstash/redis which has ESM issues in Jest)
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { auth: {} },
}))

// ── Mocks ──

const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
const STORED_NONCE = 'stored-nonce-value'

const mockDelete = jest.fn()
const mockGet = jest.fn().mockReturnValue({ value: STORED_NONCE })
const mockCookies = jest.fn().mockResolvedValue({ get: mockGet, delete: mockDelete })
jest.mock('next/headers', () => ({ cookies: () => mockCookies() }))

// Mock viem's isAddress
jest.mock('viem', () => ({
  isAddress: jest.fn((addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr)),
}))

// Mock siwe
const mockVerify = jest.fn()
jest.mock('siwe', () => ({
  SiweMessage: jest.fn().mockImplementation(() => ({
    verify: mockVerify,
  })),
}))

// Mock supabase admin
const mockMaybeSingle = jest.fn()
const mockEq = jest.fn().mockReturnValue({ maybeSingle: mockMaybeSingle })
const mockSelect = jest.fn().mockReturnValue({ eq: mockEq })
const mockGenerateLink = jest.fn().mockResolvedValue({ data: { properties: { hashed_token: 'tok' } }, error: null })
const mockCreateUser = jest.fn()
const mockUpsert = jest.fn().mockResolvedValue({ error: null })

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: mockSelect,
      upsert: mockUpsert,
    }),
    auth: {
      admin: {
        generateLink: mockGenerateLink,
        createUser: mockCreateUser,
      },
    },
  }),
}))

import { POST } from '../route'

/**
 * Create a mock NextRequest-like object that works in jsdom.
 */
function makeRequest(body: Record<string, unknown>, headers?: Record<string, string>) {
  const mergedHeaders: Record<string, string> = {
    'content-type': 'application/json',
    host: 'localhost:3000',
    origin: 'http://localhost:3000',
    ...headers,
  }
  return {
    json: async () => body,
    headers: {
      get: (key: string) => mergedHeaders[key.toLowerCase()] ?? null,
    },
  } as unknown as import('next/server').NextRequest
}

describe('POST /api/auth/siwe/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGet.mockReturnValue({ value: STORED_NONCE })
  })

  it('returns 400 when message is missing', async () => {
    const res = await POST(makeRequest({ signature: '0xabc' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing message or signature/)
  })

  it('returns 400 when signature is missing', async () => {
    const res = await POST(makeRequest({ message: 'hello' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing message or signature/)
  })

  it('returns 400 when nonce cookie is expired/missing', async () => {
    mockGet.mockReturnValue(undefined)
    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Nonce expired/)
  })

  it('returns 401 when signature verification fails', async () => {
    mockVerify.mockResolvedValue({ success: false, error: 'bad sig' })
    const res = await POST(makeRequest({ message: 'hello', signature: '0xbad' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Invalid signature/)
  })

  it('returns 400 when chainId is undefined (strict validation)', async () => {
    mockVerify.mockResolvedValue({
      success: true,
      error: null,
      data: {
        address: VALID_ADDRESS,
        domain: 'localhost:3000',
        uri: 'http://localhost:3000',
        chainId: undefined, // undefined must be rejected
      },
    })
    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Domain or chain mismatch/)
  })

  it('returns 400 when chainId does not match expected (8453)', async () => {
    mockVerify.mockResolvedValue({
      success: true,
      error: null,
      data: {
        address: VALID_ADDRESS,
        domain: 'localhost:3000',
        uri: 'http://localhost:3000',
        chainId: 1, // Wrong chain — expected 8453
      },
    })
    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when domain does not match Host header', async () => {
    mockVerify.mockResolvedValue({
      success: true,
      error: null,
      data: {
        address: VALID_ADDRESS,
        domain: 'evil.com',
        uri: 'http://localhost:3000',
        chainId: 8453,
      },
    })
    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))
    expect(res.status).toBe(400)
  })

  it('returns 400 when Host header is missing', async () => {
    mockVerify.mockResolvedValue({
      success: true,
      error: null,
      data: {
        address: VALID_ADDRESS,
        domain: 'localhost:3000',
        uri: 'http://localhost:3000',
        chainId: 8453,
      },
    })
    // Remove host header entirely
    const req = makeRequest({ message: 'hello', signature: '0xabc' }, {})
    ;(req.headers as unknown as { get: (k: string) => string | null }).get = (key: string) => {
      if (key.toLowerCase() === 'host') return null
      if (key.toLowerCase() === 'origin') return 'http://localhost:3000'
      return null
    }
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing required Host or Origin/)
  })

  it('returns 400 when Origin header is missing', async () => {
    mockVerify.mockResolvedValue({
      success: true,
      error: null,
      data: {
        address: VALID_ADDRESS,
        domain: 'localhost:3000',
        uri: 'http://localhost:3000',
        chainId: 8453,
      },
    })
    const req = makeRequest({ message: 'hello', signature: '0xabc' }, {})
    ;(req.headers as unknown as { get: (k: string) => string | null }).get = (key: string) => {
      if (key.toLowerCase() === 'host') return 'localhost:3000'
      if (key.toLowerCase() === 'origin') return null
      return null
    }
    const res = await POST(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing required Host or Origin/)
  })

  it('returns existing user data when wallet is already linked', async () => {
    mockVerify.mockResolvedValue({
      success: true,
      error: null,
      data: {
        address: VALID_ADDRESS,
        domain: 'localhost:3000',
        uri: 'http://localhost:3000',
        chainId: 8453,
      },
    })
    mockMaybeSingle.mockResolvedValue({
      data: { id: 'user-1', handle: 'alice', email: 'alice@test.com', wallet_address: VALID_ADDRESS.toLowerCase() },
      error: null,
    })

    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.action).toBe('existing_user')
    expect(body.userId).toBe('user-1')
    expect(mockDelete).toHaveBeenCalledWith('siwe-nonce')
  })
})
