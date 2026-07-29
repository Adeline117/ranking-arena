import { readFileSync } from 'node:fs'
import { join } from 'node:path'

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}))

const mockCheckRateLimit = jest.fn()
jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  RateLimitPresets: { auth: { name: 'auth-test-policy' } },
}))

const mockConsumeSiweNonce = jest.fn()
jest.mock('@/lib/auth/siwe-nonce', () => ({
  consumeSiweNonce: (...args: unknown[]) => mockConsumeSiweNonce(...args),
}))

const VALID_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678'
const OTHER_ADDRESS = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd'
const STORED_NONCE = 'stored-nonce-value'
const MOCK_USER = { id: 'user-1', email: 'test@test.com' }

const mockDeleteCookie = jest.fn()
const mockGetCookie = jest.fn()
jest.mock('next/headers', () => ({
  cookies: jest.fn(async () => ({ get: mockGetCookie, delete: mockDeleteCookie })),
}))

jest.mock('viem', () => ({
  isAddress: jest.fn((address: string) => /^0x[0-9a-fA-F]{40}$/.test(address)),
}))

const mockVerify = jest.fn()
jest.mock('siwe', () => ({
  SiweMessage: jest.fn().mockImplementation(() => ({ verify: mockVerify })),
}))

const mockRpc = jest.fn()

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
  getProvisioningAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { POST } from '../route'

function makeRequest(
  body: unknown,
  options: { token?: string; host?: string | null; origin?: string | null } = {}
) {
  const headers: Record<string, string> = {
    host: options.host === undefined ? 'www.arenafi.org' : options.host || '',
    origin: options.origin === undefined ? 'https://www.arenafi.org' : options.origin || '',
  }
  if (options.token) headers.authorization = `Bearer ${options.token}`
  return {
    json: async () => body,
    headers: {
      get: (key: string) => headers[key.toLowerCase()] || null,
    },
  } as unknown as import('next/server').NextRequest
}

function validFields(overrides: Record<string, unknown> = {}) {
  return {
    address: VALID_ADDRESS,
    domain: 'www.arenafi.org',
    uri: 'https://www.arenafi.org',
    chainId: 8453,
    ...overrides,
  }
}

function walletBinding(status = 'active') {
  return {
    data: [
      {
        status,
        result_user_id: status === 'active' ? MOCK_USER.id : null,
        result_handle: status === 'active' ? 'test' : null,
        result_email: status === 'active' ? MOCK_USER.email : null,
        result_wallet_address: status === 'active' ? VALID_ADDRESS : null,
      },
    ],
    error: null,
  }
}

describe('POST /api/auth/siwe/link', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockConsumeSiweNonce.mockResolvedValue(true)
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockGetCookie.mockReturnValue({ value: STORED_NONCE })
    mockVerify.mockResolvedValue({ success: true, error: null, data: validFields() })
    mockRpc.mockResolvedValue(walletBinding())
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc })
  })

  it('requires authentication before reading the request or database', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it.each([
    [{ message: 'hello' }, 'missing signature'],
    [{ signature: '0xabc' }, 'missing message'],
    [{ message: 1, signature: '0xabc' }, 'wrong message type'],
    [{ message: 'hello', signature: '0xabc', userId: 'other' }, 'unknown field'],
  ])('rejects an invalid body (%s: %s)', async (body) => {
    const response = await POST(makeRequest(body, { token: 'token' }))

    expect(response.status).toBe(400)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('rejects an expired nonce, invalid signature, origin mismatch, and invalid address', async () => {
    mockGetCookie.mockReturnValueOnce(undefined)
    expect(
      (await POST(makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' }))).status
    ).toBe(400)

    mockVerify.mockResolvedValueOnce({ success: false, error: 'bad signature', data: null })
    expect(
      (await POST(makeRequest({ message: 'hello', signature: '0xbad' }, { token: 'token' }))).status
    ).toBe(401)

    mockVerify.mockResolvedValueOnce({
      success: true,
      error: null,
      data: validFields({ domain: 'evil.example' }),
    })
    expect(
      (await POST(makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' }))).status
    ).toBe(400)

    mockVerify.mockResolvedValueOnce({
      success: true,
      error: null,
      data: validFields({ address: 'not-an-address' }),
    })
    expect(
      (await POST(makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' }))).status
    ).toBe(400)
  })

  it('rejects a replayed server-side nonce before every wallet mutation', async () => {
    mockConsumeSiweNonce.mockResolvedValue(false)

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(400)
    expect(mockConsumeSiweNonce).toHaveBeenCalledWith(STORED_NONCE)
    expect(mockDeleteCookie).toHaveBeenCalledWith('siwe-nonce')
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed when atomic wallet admission errors', async () => {
    mockRpc.mockResolvedValue({
      data: null,
      error: { code: 'XX002', message: 'wallet admission failed' },
    })

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(503)
  })

  it('rejects an atomic wallet or account ownership conflict', async () => {
    mockRpc.mockResolvedValue(walletBinding('conflict'))

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(409)
  })

  it('rejects a lifecycle suspension that wins after bearer admission', async () => {
    mockRpc.mockResolvedValue(walletBinding('suspended'))

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(403)
  })

  it.each([
    [{ data: [], error: null }, 'empty acknowledgement'],
    [{ data: [walletBinding().data[0], walletBinding().data[0]], error: null }, 'multiple rows'],
    [
      {
        data: [{ ...walletBinding().data[0], result_user_id: 'other-user' }],
        error: null,
      },
      'wrong subject',
    ],
    [
      {
        data: [{ ...walletBinding().data[0], result_wallet_address: OTHER_ADDRESS }],
        error: null,
      },
      'wrong wallet',
    ],
    [walletBinding('missing'), 'missing profile'],
  ])('fails closed for an invalid atomic acknowledgement (%s: %s)', async (result) => {
    mockRpc.mockResolvedValue(result)

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(503)
  })

  it('links through the exact active-profile atomic authority', async () => {
    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, walletAddress: VALID_ADDRESS })
    expect(mockRpc).toHaveBeenCalledWith('bind_siwe_wallet_for_active_profile_atomic', {
      p_user_id: MOCK_USER.id,
      p_wallet_address: VALID_ADDRESS,
    })
    expect(mockDeleteCookie).toHaveBeenCalledWith('siwe-nonce')
  })

  it('contains no client-derived profile provisioner', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/auth/siwe/link/route.ts'), 'utf8')
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.upsert(')
    expect(source).not.toMatch(/\.update\(\{ wallet_address: walletAddress \}\)/)
  })
})
