/**
 * Tests for POST /api/auth/siwe/link
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

const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
const STORED_NONCE = 'stored-nonce-value'
const MOCK_USER = { id: 'user-1', email: 'test@test.com' }

// ── Mocks ──

const mockDelete = jest.fn()
const mockGet = jest.fn().mockReturnValue({ value: STORED_NONCE })
const mockCookies = jest.fn().mockResolvedValue({ get: mockGet, delete: mockDelete })
jest.mock('next/headers', () => ({ cookies: () => mockCookies() }))

jest.mock('viem', () => ({
  isAddress: jest.fn((addr: string) => /^0x[0-9a-fA-F]{40}$/.test(addr)),
}))

const mockVerify = jest.fn()
jest.mock('siwe', () => ({
  SiweMessage: jest.fn().mockImplementation(() => ({
    verify: mockVerify,
  })),
}))

const mockMaybeSingle = jest.fn()
const mockNeq = jest.fn().mockReturnValue({ maybeSingle: mockMaybeSingle })
const mockEq = jest.fn().mockReturnValue({ neq: mockNeq })
const mockSelect = jest.fn().mockReturnValue({ eq: mockEq })
const mockUpdateEq = jest.fn().mockResolvedValue({ error: null })
const mockUpdate = jest.fn().mockReturnValue({ eq: mockUpdateEq })

const mockGetAuthUser = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: () => ({
      select: mockSelect,
      update: mockUpdate,
    }),
  }),
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

import { POST } from '../route'

/**
 * Create a mock NextRequest-like object that works in jsdom.
 */
function makeRequest(body: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (token) headers['authorization'] = `Bearer ${token}`
  return {
    json: async () => body,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] ?? null,
    },
  } as unknown as import('next/server').NextRequest
}

describe('POST /api/auth/siwe/link', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGet.mockReturnValue({ value: STORED_NONCE })
    mockGetAuthUser.mockResolvedValue(null)
  })

  it('returns 401 for unauthenticated request', async () => {
    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Not authenticated/)
  })

  it('returns 400 when message or signature is missing', async () => {
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    const res = await POST(makeRequest({ message: 'hello' }, 'token'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Missing message or signature/)
  })

  it('returns 400 when nonce is expired', async () => {
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockGet.mockReturnValue(undefined)
    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }, 'token'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Nonce expired/)
  })

  it('returns 401 when signature is invalid', async () => {
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockVerify.mockResolvedValue({ success: false, data: null })
    const res = await POST(makeRequest({ message: 'hello', signature: '0xbad' }, 'token'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error).toMatch(/Invalid signature/)
  })

  it('returns 400 for invalid wallet address format', async () => {
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockVerify.mockResolvedValue({
      success: true,
      data: { address: 'not-an-address' },
    })
    const { isAddress } = require('viem')
    ;(isAddress as jest.Mock).mockReturnValueOnce(false)

    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }, 'token'))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Invalid wallet address/)
  })

  it('returns 409 when wallet is already linked to another user', async () => {
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockVerify.mockResolvedValue({
      success: true,
      data: { address: VALID_ADDRESS },
    })
    mockMaybeSingle.mockResolvedValue({ data: { id: 'other-user' }, error: null })

    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }, 'token'))
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error).toMatch(/already linked/)
  })

  it('returns success when wallet is linked', async () => {
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockVerify.mockResolvedValue({
      success: true,
      data: { address: VALID_ADDRESS },
    })
    mockMaybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await POST(makeRequest({ message: 'hello', signature: '0xabc' }, 'token'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.walletAddress).toBe(VALID_ADDRESS.toLowerCase())
    expect(mockDelete).toHaveBeenCalledWith('siwe-nonce')
  })
})
