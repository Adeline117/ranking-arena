jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}))

const mockVerifyAuthenticationResponse = jest.fn()
jest.mock('@simplewebauthn/server', () => ({
  verifyAuthenticationResponse: (...args: unknown[]) => mockVerifyAuthenticationResponse(...args),
}))
jest.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: { toBuffer: jest.fn(() => Buffer.from('public-key')) },
}))

const mockConsumeChallenge = jest.fn()
jest.mock('@/lib/auth/webauthn', () => ({
  consumeAuthenticationChallenge: (...args: unknown[]) => mockConsumeChallenge(...args),
  getWebAuthnConfig: () => ({ rpID: 'www.arenafi.org', origin: 'https://www.arenafi.org' }),
}))

const mockLookupCredential = jest.fn()
const mockConsumeAssertion = jest.fn()
const mockGetUserById = jest.fn()
const mockGenerateLink = jest.fn()
const mockVerifyOtp = jest.fn()
const mockGetUserAccountStatus = jest.fn()

jest.mock('@/lib/supabase/server', () => ({
  getUserAccountStatus: (...args: unknown[]) => mockGetUserAccountStatus(...args),
}))

const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table === 'user_passkeys') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockLookupCredential }) }),
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  }),
  rpc: (...args: unknown[]) => mockConsumeAssertion(...args),
  auth: {
    admin: {
      getUserById: (...args: unknown[]) => mockGetUserById(...args),
      generateLink: (...args: unknown[]) => mockGenerateLink(...args),
    },
  },
}

jest.mock('@/lib/api/middleware', () => ({
  withPublic:
    (handler: (context: { supabase: typeof mockSupabase; request: unknown }) => unknown) =>
    (request: unknown) =>
      handler({ supabase: mockSupabase, request }),
}))

jest.mock('@/lib/api/response', () => ({
  badRequest: (message: string) => ({
    status: 400,
    json: async () => ({ error: message }),
  }),
  serverError: (message: string) => ({
    status: 500,
    json: async () => ({ error: message }),
  }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ auth: { verifyOtp: (...args: unknown[]) => mockVerifyOtp(...args) } }),
}))

import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const CREDENTIAL_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: USER_ID,
  public_key: 'cHVibGljLWtleQ',
  counter: 4,
  last_used_at: '2026-07-28T00:00:00.000000+00:00',
  transports: ['internal'],
}

function consumedAssertion() {
  return {
    data: [
      {
        status: 'consumed',
        result_user_id: USER_ID,
        result_passkey_id: CREDENTIAL_ROW.id,
        result_credential_id: 'credential-id',
        consumed_at: '2026-07-29T00:00:00.000001+00:00',
      },
    ],
    error: null,
  }
}

function request() {
  return {
    json: async () => ({
      assertion: { id: 'credential-id', rawId: 'credential-id' },
      challengeKey: 'challenge-key',
    }),
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest
}

describe('POST /api/auth/webauthn/authentication-verify', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockConsumeChallenge.mockResolvedValue('expected-challenge')
    mockLookupCredential.mockResolvedValue({ data: CREDENTIAL_ROW, error: null })
    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    })
    mockConsumeAssertion.mockResolvedValue(consumedAssertion())
    mockGetUserAccountStatus.mockResolvedValue('active')
    mockGetUserById.mockResolvedValue({
      data: { user: { id: USER_ID, email: 'wallet@example.com' } },
      error: null,
    })
    mockGenerateLink.mockResolvedValue({
      data: { properties: { hashed_token: 'hashed-token' } },
      error: null,
    })
    mockVerifyOtp.mockResolvedValue({
      data: {
        session: {
          user: { id: USER_ID },
          access_token: 'access-token',
          refresh_token: 'refresh-token',
        },
      },
      error: null,
    })
  })

  it('mints a session only after exact atomic assertion consumption and three active checks', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      verified: true,
      session: { access_token: 'access-token', refresh_token: 'refresh-token' },
    })
    expect(mockVerifyAuthenticationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'expected-challenge',
        expectedOrigin: 'https://www.arenafi.org',
        expectedRPID: 'www.arenafi.org',
        requireUserVerification: true,
      })
    )
    expect(mockConsumeAssertion).toHaveBeenCalledWith('consume_webauthn_authentication_atomic', {
      p_user_id: USER_ID,
      p_passkey_id: CREDENTIAL_ROW.id,
      p_credential_id: 'credential-id',
      p_expected_public_key: CREDENTIAL_ROW.public_key,
      p_expected_counter: 4,
      p_expected_last_used_at: CREDENTIAL_ROW.last_used_at,
      p_new_counter: 5,
    })
    expect(mockConsumeAssertion.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateLink.mock.invocationCallOrder[0]
    )
    expect(mockGetUserAccountStatus).toHaveBeenCalledTimes(3)
    expect(mockGetUserAccountStatus).toHaveBeenNthCalledWith(1, USER_ID, {
      verifiedEmail: 'wallet@example.com',
    })
    expect(mockGetUserAccountStatus.mock.invocationCallOrder[1]).toBeLessThan(
      mockVerifyOtp.mock.invocationCallOrder[0]
    )
    expect(mockVerifyOtp.mock.invocationCallOrder[0]).toBeLessThan(
      mockGetUserAccountStatus.mock.invocationCallOrder[2]
    )
  })

  it.each([
    [{ data: null, error: { code: 'XX001' } }, 'database error'],
    [{ data: [], error: null }, 'empty acknowledgement'],
    [
      {
        data: [consumedAssertion().data[0], consumedAssertion().data[0]],
        error: null,
      },
      'multiple acknowledgements',
    ],
    [
      {
        data: [{ ...consumedAssertion().data[0], status: 'suspended' }],
        error: null,
      },
      'suspended account',
    ],
    [
      {
        data: [{ ...consumedAssertion().data[0], status: 'conflict' }],
        error: null,
      },
      'counter conflict',
    ],
    [
      {
        data: [{ ...consumedAssertion().data[0], result_user_id: 'other-user' }],
        error: null,
      },
      'wrong subject',
    ],
    [
      {
        data: [{ ...consumedAssertion().data[0], consumed_at: null }],
        error: null,
      },
      'missing consumption generation',
    ],
  ])('fails closed for an invalid atomic consumption (%s: %s)', async (result) => {
    mockConsumeAssertion.mockResolvedValue(result)

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it('preserves counterless assertions while binding their last-used CAS generation', async () => {
    mockLookupCredential.mockResolvedValue({
      data: { ...CREDENTIAL_ROW, counter: '0', last_used_at: null },
      error: null,
    })
    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: 0 },
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockConsumeAssertion).toHaveBeenCalledWith(
      'consume_webauthn_authentication_atomic',
      expect.objectContaining({
        p_expected_counter: 0,
        p_expected_last_used_at: null,
        p_new_counter: 0,
      })
    )
  })

  it.each([
    [-1, 'negative number'],
    [Number.MAX_SAFE_INTEGER + 1, 'unsafe number'],
    ['01', 'non-canonical decimal'],
    ['9223372036854775807', 'unsafe bigint'],
  ])(
    'rejects an invalid stored counter before cryptographic verification: %s (%s)',
    async (counter) => {
      mockLookupCredential.mockResolvedValue({ data: { ...CREDENTIAL_ROW, counter }, error: null })

      const response = await POST(request())

      expect(response.status).toBe(500)
      expect(mockVerifyAuthenticationResponse).not.toHaveBeenCalled()
      expect(mockConsumeAssertion).not.toHaveBeenCalled()
    }
  )

  it('rejects an invalid verified counter without consuming the assertion', async () => {
    mockVerifyAuthenticationResponse.mockResolvedValue({
      verified: true,
      authenticationInfo: { newCounter: Number.MAX_SAFE_INTEGER + 1 },
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockConsumeAssertion).not.toHaveBeenCalled()
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it.each([
    [['suspended'], false, false, 'before link generation'],
    [['active', 'suspended'], true, false, 'before session mint'],
    [['active', 'active', 'suspended'], true, true, 'before token release'],
  ])(
    'withholds credentials when lifecycle changes %s',
    async (statuses, generatedLink, mintedSession, _label) => {
      for (const status of statuses) {
        mockGetUserAccountStatus.mockResolvedValueOnce(status)
      }

      const response = await POST(request())

      expect(response.status).toBe(500)
      expect(mockGenerateLink).toHaveBeenCalledTimes(generatedLink ? 1 : 0)
      expect(mockVerifyOtp).toHaveBeenCalledTimes(mintedSession ? 1 : 0)
      expect(await response.json()).not.toHaveProperty('session')
    }
  )

  it('rejects a Supabase session belonging to another identity', async () => {
    mockVerifyOtp.mockResolvedValue({
      data: {
        session: {
          user: { id: '22222222-2222-4222-8222-222222222222' },
          access_token: 'wrong-access-token',
          refresh_token: 'wrong-refresh-token',
        },
      },
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(await response.json()).not.toHaveProperty('session')
  })

  it('rejects an Auth lookup response belonging to another identity before link minting', async () => {
    mockGetUserById.mockResolvedValue({
      data: {
        user: {
          id: '22222222-2222-4222-8222-222222222222',
          email: 'wrong@example.com',
        },
      },
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockGenerateLink).not.toHaveBeenCalled()
    expect(mockVerifyOtp).not.toHaveBeenCalled()
  })

  it('contains no direct profile admission or credential mutation', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.join(process.cwd(), 'app/api/auth/webauthn/authentication-verify/route.ts'),
      'utf8'
    )
    const optionsSource = fs.readFileSync(
      path.join(process.cwd(), 'app/api/auth/webauthn/authentication-options/route.ts'),
      'utf8'
    )

    expect(source).not.toMatch(/\.from\(['"]user_profiles['"]\)/)
    expect(source).not.toMatch(/\.from\(['"]user_passkeys['"]\)[\s\S]*?\.update\(/)
    expect(source).toContain("'consume_webauthn_authentication_atomic'")
    expect(source).toContain('requireUserVerification: true')
    expect(optionsSource).toContain('allowCredentials: []')
    expect(optionsSource).toContain("userVerification: 'required'")
  })
})
