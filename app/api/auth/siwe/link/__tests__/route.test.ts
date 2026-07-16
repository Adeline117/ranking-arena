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

const mockFrom = jest.fn()
const mockSelect = jest.fn()
const mockEq = jest.fn()
const mockNeq = jest.fn()
const mockIs = jest.fn()
const mockUpdate = jest.fn()
const mockMaybeSingle = jest.fn()
const query = {
  select: mockSelect,
  eq: mockEq,
  neq: mockNeq,
  is: mockIs,
  update: mockUpdate,
  maybeSingle: mockMaybeSingle,
}

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

describe('POST /api/auth/siwe/link', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue(MOCK_USER)
    mockGetCookie.mockReturnValue({ value: STORED_NONCE })
    mockVerify.mockResolvedValue({ success: true, error: null, data: validFields() })
    mockFrom.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockNeq.mockReturnValue(query)
    mockIs.mockReturnValue(query)
    mockUpdate.mockReturnValue(query)
    mockMaybeSingle.mockReset()
    mockMaybeSingle
      .mockResolvedValueOnce({ data: { id: MOCK_USER.id, wallet_address: null }, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({
        data: { id: MOCK_USER.id, wallet_address: VALID_ADDRESS },
        error: null,
      })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom })
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

  it('fails closed when the trigger-provisioned profile is missing or errors', async () => {
    mockMaybeSingle.mockReset().mockResolvedValueOnce({ data: null, error: null })
    expect(
      (await POST(makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' }))).status
    ).toBe(503)
    expect(mockUpdate).not.toHaveBeenCalled()

    mockMaybeSingle.mockReset().mockResolvedValueOnce({
      data: null,
      error: { code: 'XX001', message: 'read failed' },
    })
    expect(
      (await POST(makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' }))).status
    ).toBe(503)
  })

  it('fails closed when wallet ownership lookup errors', async () => {
    mockMaybeSingle
      .mockReset()
      .mockResolvedValueOnce({ data: { id: MOCK_USER.id, wallet_address: null }, error: null })
      .mockResolvedValueOnce({
        data: null,
        error: { code: 'XX002', message: 'wallet lookup failed' },
      })

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(503)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects a wallet owned by another user', async () => {
    mockMaybeSingle
      .mockReset()
      .mockResolvedValueOnce({ data: { id: MOCK_USER.id, wallet_address: null }, error: null })
      .mockResolvedValueOnce({ data: { id: 'other-user' }, error: null })

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(409)
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('rejects replacing an already-linked different wallet', async () => {
    mockMaybeSingle.mockReset().mockResolvedValueOnce({
      data: { id: MOCK_USER.id, wallet_address: OTHER_ADDRESS },
      error: null,
    })

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(409)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockNeq).not.toHaveBeenCalled()
  })

  it('returns idempotent success for the same existing wallet without writing', async () => {
    mockMaybeSingle
      .mockReset()
      .mockResolvedValueOnce({
        data: { id: MOCK_USER.id, wallet_address: VALID_ADDRESS },
        error: null,
      })
      .mockResolvedValueOnce({ data: null, error: null })

    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, walletAddress: VALID_ADDRESS })
    expect(mockUpdate).not.toHaveBeenCalled()
  })

  it('binds only the authenticated existing profile and verifies the returned row', async () => {
    const response = await POST(
      makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ success: true, walletAddress: VALID_ADDRESS })
    expect(mockUpdate).toHaveBeenCalledWith({ wallet_address: VALID_ADDRESS })
    expect(mockEq).toHaveBeenCalledWith('id', MOCK_USER.id)
    expect(mockIs).toHaveBeenCalledWith('wallet_address', null)
    expect(mockSelect).toHaveBeenCalledWith('id, wallet_address')
    expect(mockDeleteCookie).toHaveBeenCalledWith('siwe-nonce')
  })

  it.each([
    [{ data: null, error: { code: 'XX003', message: 'write failed' } }, 503],
    [{ data: null, error: null }, 503],
    [{ data: { id: MOCK_USER.id, wallet_address: OTHER_ADDRESS }, error: null }, 503],
    [{ data: null, error: { code: '23505', message: 'duplicate wallet' } }, 409],
  ])(
    'does not report success for an unconfirmed wallet update (%s)',
    async (updateResult, status) => {
      mockMaybeSingle
        .mockReset()
        .mockResolvedValueOnce({ data: { id: MOCK_USER.id, wallet_address: null }, error: null })
        .mockResolvedValueOnce({ data: null, error: null })
        .mockResolvedValueOnce(updateResult)

      const response = await POST(
        makeRequest({ message: 'hello', signature: '0xabc' }, { token: 'token' })
      )

      expect(response.status).toBe(status)
    }
  )

  it('contains no client-derived profile provisioner', () => {
    const source = readFileSync(join(process.cwd(), 'app/api/auth/siwe/link/route.ts'), 'utf8')
    expect(source).not.toContain('.insert(')
    expect(source).not.toContain('.upsert(')
  })
})
