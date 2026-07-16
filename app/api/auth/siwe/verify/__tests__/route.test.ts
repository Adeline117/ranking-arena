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
const WALLET_EMAIL = `${VALID_ADDRESS}@wallet.arena`
const STORED_NONCE = 'stored-nonce-value'

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
const mockIs = jest.fn()
const mockUpdate = jest.fn()
const mockMaybeSingle = jest.fn()
const query = {
  select: mockSelect,
  eq: mockEq,
  is: mockIs,
  update: mockUpdate,
  maybeSingle: mockMaybeSingle,
}
const mockGenerateLink = jest.fn()
const mockCreateUser = jest.fn()
const mockGetUserById = jest.fn()
const mockGetSupabaseAdmin = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { POST } from '../route'

function makeRequest(
  body: unknown,
  options: { host?: string | null; origin?: string | null; rejectJson?: boolean } = {}
) {
  const host = options.host === undefined ? 'localhost:3000' : options.host
  const origin = options.origin === undefined ? 'http://localhost:3000' : options.origin
  return {
    json: options.rejectJson
      ? async () => {
          throw new Error('malformed json')
        }
      : async () => body,
    headers: {
      get: (key: string) => {
        if (key.toLowerCase() === 'host') return host
        if (key.toLowerCase() === 'origin') return origin
        return null
      },
    },
  } as unknown as import('next/server').NextRequest
}

function validFields(overrides: Record<string, unknown> = {}) {
  return {
    address: VALID_ADDRESS,
    domain: 'localhost:3000',
    uri: 'http://localhost:3000',
    chainId: 8453,
    ...overrides,
  }
}

const existingProfile = {
  id: 'user-1',
  handle: 'alice',
  email: 'alice@test.com',
  wallet_address: VALID_ADDRESS,
}

describe('POST /api/auth/siwe/verify', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetCookie.mockReturnValue({ value: STORED_NONCE })
    mockVerify.mockResolvedValue({ success: true, error: null, data: validFields() })

    mockFrom.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockIs.mockReturnValue(query)
    mockUpdate.mockReturnValue(query)
    mockMaybeSingle.mockResolvedValue({ data: existingProfile, error: null })
    mockGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'verification-token' } },
      error: null,
    })
    mockCreateUser.mockResolvedValue({ data: { user: null }, error: new Error('unexpected') })
    mockGetUserById.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'alice@test.com' } },
      error: null,
    })
    mockGetSupabaseAdmin.mockReturnValue({
      from: mockFrom,
      auth: {
        admin: {
          generateLink: mockGenerateLink,
          createUser: mockCreateUser,
          getUserById: mockGetUserById,
        },
      },
    })
  })

  it.each([
    [{ signature: '0xabc' }, 'missing message'],
    [{ message: 'hello' }, 'missing signature'],
    [{ message: 123, signature: '0xabc' }, 'non-string message'],
    [{ message: 'hello', signature: '0xabc', userId: 'attacker' }, 'unknown field'],
  ])('rejects an invalid request body (%s: %s)', async (body) => {
    const response = await POST(makeRequest(body))

    expect(response.status).toBe(400)
    expect(mockVerify).not.toHaveBeenCalled()
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('rejects malformed JSON and an expired nonce', async () => {
    expect((await POST(makeRequest(null, { rejectJson: true }))).status).toBe(400)

    mockGetCookie.mockReturnValue(undefined)
    expect((await POST(makeRequest({ message: 'hello', signature: '0xabc' }))).status).toBe(400)
    expect(mockVerify).not.toHaveBeenCalled()
  })

  it('rejects invalid signatures, origin/domain/chain mismatches, and invalid addresses', async () => {
    mockVerify.mockResolvedValueOnce({ success: false, error: 'bad signature', data: null })
    expect((await POST(makeRequest({ message: 'hello', signature: '0xbad' }))).status).toBe(401)

    mockVerify.mockResolvedValueOnce({
      success: true,
      error: null,
      data: validFields({ chainId: 1 }),
    })
    expect((await POST(makeRequest({ message: 'hello', signature: '0xabc' }))).status).toBe(400)

    mockVerify.mockResolvedValueOnce({
      success: true,
      error: null,
      data: validFields({ domain: 'evil.example' }),
    })
    expect((await POST(makeRequest({ message: 'hello', signature: '0xabc' }))).status).toBe(400)

    mockVerify.mockResolvedValueOnce({
      success: true,
      error: null,
      data: validFields({ address: 'not-an-address' }),
    })
    expect((await POST(makeRequest({ message: 'hello', signature: '0xabc' }))).status).toBe(400)
  })

  it('requires both Host and Origin headers', async () => {
    expect(
      (
        await POST(
          makeRequest(
            { message: 'hello', signature: '0xabc' },
            { host: null, origin: 'http://localhost:3000' }
          )
        )
      ).status
    ).toBe(400)
    expect(
      (
        await POST(
          makeRequest(
            { message: 'hello', signature: '0xabc' },
            { host: 'localhost:3000', origin: null }
          )
        )
      ).status
    ).toBe(400)
  })

  it('returns token, email, and exact identity only after all existing-user lookups succeed', async () => {
    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      action: 'existing_user',
      userId: 'user-1',
      handle: 'alice',
      walletAddress: VALID_ADDRESS,
      email: 'alice@test.com',
      verificationToken: 'verification-token',
    })
    expect(mockDeleteCookie).toHaveBeenCalledWith('siwe-nonce')
    expect(mockGetUserById).toHaveBeenCalledWith('user-1')
    expect(mockGenerateLink).toHaveBeenCalledWith({
      type: 'magiclink',
      email: 'alice@test.com',
    })
  })

  it('fails closed when the wallet lookup errors', async () => {
    mockMaybeSingle.mockResolvedValueOnce({
      data: null,
      error: { code: 'XX001', message: 'lookup failed' },
    })

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(503)
    expect(mockCreateUser).not.toHaveBeenCalled()
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it.each([
    [{ data: { user: null }, error: null }, 'missing auth user'],
    [
      { data: { user: { id: 'other-user', email: 'alice@test.com' } }, error: null },
      'wrong auth user',
    ],
    [{ data: { user: { id: 'user-1', email: null } }, error: null }, 'missing auth email'],
    [{ data: { user: null }, error: { code: 'auth_down' } }, 'auth lookup error'],
  ])('fails closed when the exact auth identity is unavailable (%s: %s)', async (authResult) => {
    mockGetUserById.mockResolvedValue(authResult)

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(503)
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it.each([
    [{ data: null, error: { code: 'link_failed' } }, 'generateLink error'],
    [{ data: { properties: {} }, error: null }, 'missing token'],
  ])('fails closed when a usable verification token is not issued (%s: %s)', async (linkResult) => {
    mockGenerateLink.mockResolvedValue(linkResult)

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(503)
  })

  it('uses only the trigger-provisioned row for a new wallet user', async () => {
    const provisionedProfile = {
      id: 'new-user',
      handle: '0x123456_unique',
      email: WALLET_EMAIL,
      wallet_address: null,
    }
    const boundProfile = { ...provisionedProfile, wallet_address: VALID_ADDRESS }
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: provisionedProfile, error: null })
      .mockResolvedValueOnce({ data: boundProfile, error: null })
    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'new-user', email: WALLET_EMAIL } },
      error: null,
    })
    mockGetUserById.mockResolvedValue({
      data: { user: { id: 'new-user', email: WALLET_EMAIL } },
      error: null,
    })

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      action: 'new_user',
      userId: 'new-user',
      handle: '0x123456_unique',
      email: WALLET_EMAIL,
      verificationToken: 'verification-token',
    })
    expect(mockUpdate).toHaveBeenCalledWith({ wallet_address: VALID_ADDRESS })
    expect(mockIs).toHaveBeenCalledWith('wallet_address', null)
    expect(query).not.toHaveProperty('insert')
    expect(query).not.toHaveProperty('upsert')
  })

  it('fails closed instead of recreating a missing trigger-provisioned profile', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'new-user', email: WALLET_EMAIL } },
      error: null,
    })

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(503)
    expect(mockUpdate).not.toHaveBeenCalled()
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it('fails closed on a wallet-binding error or zero-row update', async () => {
    const provisionedProfile = {
      id: 'new-user',
      handle: 'wallet-user',
      email: WALLET_EMAIL,
      wallet_address: null,
    }
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: provisionedProfile, error: null })
      .mockResolvedValueOnce({ data: null, error: { code: 'XX002', message: 'write failed' } })
    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'new-user', email: WALLET_EMAIL } },
      error: null,
    })

    expect((await POST(makeRequest({ message: 'hello', signature: '0xabc' }))).status).toBe(503)

    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetCookie.mockReturnValue({ value: STORED_NONCE })
    mockVerify.mockResolvedValue({ success: true, error: null, data: validFields() })
    mockFrom.mockReturnValue(query)
    mockSelect.mockReturnValue(query)
    mockEq.mockReturnValue(query)
    mockIs.mockReturnValue(query)
    mockUpdate.mockReturnValue(query)
    mockGetSupabaseAdmin.mockReturnValue({
      from: mockFrom,
      auth: {
        admin: {
          generateLink: mockGenerateLink,
          createUser: mockCreateUser,
          getUserById: mockGetUserById,
        },
      },
    })
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: provisionedProfile, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: provisionedProfile, error: null })
    mockCreateUser.mockResolvedValue({
      data: { user: { id: 'new-user', email: WALLET_EMAIL } },
      error: null,
    })

    expect((await POST(makeRequest({ message: 'hello', signature: '0xabc' }))).status).toBe(503)
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it('recovers an already-registered wallet auth user only through its required profile', async () => {
    const unboundProfile = {
      id: 'existing-wallet-user',
      handle: 'wallet-user',
      email: WALLET_EMAIL,
      wallet_address: null,
    }
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: unboundProfile, error: null })
      .mockResolvedValueOnce({
        data: { ...unboundProfile, wallet_address: VALID_ADDRESS },
        error: null,
      })
    mockCreateUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'email_exists', message: 'already registered' },
    })
    mockGetUserById.mockResolvedValue({
      data: { user: { id: 'existing-wallet-user', email: WALLET_EMAIL } },
      error: null,
    })

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      action: 'existing_user',
      userId: 'existing-wallet-user',
      email: WALLET_EMAIL,
      verificationToken: 'verification-token',
    })
  })

  it('fails closed when an already-registered auth user has no profile', async () => {
    mockMaybeSingle
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: null, error: null })
    mockCreateUser.mockResolvedValue({
      data: { user: null },
      error: { code: 'email_exists', message: 'already registered' },
    })

    const response = await POST(makeRequest({ message: 'hello', signature: '0xabc' }))

    expect(response.status).toBe(503)
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })
})
