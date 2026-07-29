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
const mockLookupProfile = jest.fn()
const mockUpdateCredential = jest.fn()
const mockUpdateCredentialEq = jest.fn()
const mockUpdateCredentialPayload = jest.fn()
const mockGetUserById = jest.fn()
const mockGenerateLink = jest.fn()
const mockVerifyOtp = jest.fn()

const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table === 'user_profiles') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockLookupProfile }) }),
      }
    }
    if (table === 'user_passkeys') {
      const updateBuilder = {
        eq: (...args: unknown[]) => {
          mockUpdateCredentialEq(...args)
          return updateBuilder
        },
        select: () => ({ maybeSingle: mockUpdateCredential }),
      }
      return {
        select: () => ({ eq: () => ({ maybeSingle: mockLookupCredential }) }),
        update: (...args: unknown[]) => {
          mockUpdateCredentialPayload(...args)
          return updateBuilder
        },
      }
    }
    throw new Error(`Unexpected table: ${table}`)
  }),
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
  id: 'credential-row-id',
  user_id: USER_ID,
  public_key: 'cHVibGljLWtleQ',
  counter: 4,
  transports: ['internal'],
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
    mockLookupProfile.mockResolvedValue({
      data: {
        id: USER_ID,
        banned_at: null,
        ban_expires_at: null,
        deleted_at: null,
        is_banned: false,
      },
      error: null,
    })
    mockUpdateCredential.mockResolvedValue({ data: { id: CREDENTIAL_ROW.id }, error: null })
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

  it('mints a session only after the required profile and replay counter are persisted', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      verified: true,
      session: { access_token: 'access-token', refresh_token: 'refresh-token' },
    })
    expect(mockLookupProfile).toHaveBeenCalledTimes(1)
    expect(mockUpdateCredential).toHaveBeenCalledTimes(1)
    expect(mockUpdateCredentialPayload).toHaveBeenCalledWith(
      expect.objectContaining({ counter: 5, last_used_at: expect.any(String) })
    )
    expect(mockUpdateCredentialEq.mock.calls).toEqual([
      ['id', CREDENTIAL_ROW.id],
      ['user_id', USER_ID],
      ['credential_id', 'credential-id'],
      ['counter', 4],
    ])
    expect(mockLookupProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateLink.mock.invocationCallOrder[0]
    )
    expect(mockUpdateCredential.mock.invocationCallOrder[0]).toBeLessThan(
      mockGenerateLink.mock.invocationCallOrder[0]
    )
  })

  it.each([
    [{ data: null, error: null }, 'missing profile'],
    [{ data: null, error: { code: 'XX001' } }, 'profile lookup error'],
  ])('fails closed for %s (%s)', async (profileResult) => {
    mockLookupProfile.mockResolvedValue(profileResult)

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockUpdateCredential).not.toHaveBeenCalled()
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

  it.each([
    [
      'banned',
      {
        id: USER_ID,
        banned_at: '2026-07-29T00:00:00.000Z',
        ban_expires_at: null,
        deleted_at: null,
        is_banned: false,
      },
    ],
    [
      'deleted',
      {
        id: USER_ID,
        banned_at: null,
        ban_expires_at: null,
        deleted_at: '2026-07-29T00:00:00.000Z',
        is_banned: false,
      },
    ],
    [
      'active legacy ban',
      {
        id: USER_ID,
        banned_at: null,
        ban_expires_at: '2999-01-01T00:00:00.000Z',
        deleted_at: null,
        is_banned: true,
      },
    ],
    [
      'wrong-subject',
      {
        id: '22222222-2222-4222-8222-222222222222',
        banned_at: null,
        ban_expires_at: null,
        deleted_at: null,
        is_banned: false,
      },
    ],
  ])('does not mint a session for a %s profile', async (_label, profile) => {
    mockLookupProfile.mockResolvedValue({ data: profile, error: null })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockUpdateCredential).not.toHaveBeenCalled()
    expect(mockGetUserById).not.toHaveBeenCalled()
    expect(mockGenerateLink).not.toHaveBeenCalled()
    expect(mockVerifyOtp).not.toHaveBeenCalled()
  })

  it('allows a legacy temporary ban only after its expiry', async () => {
    mockLookupProfile.mockResolvedValue({
      data: {
        id: USER_ID,
        banned_at: null,
        ban_expires_at: '2000-01-01T00:00:00.000Z',
        deleted_at: null,
        is_banned: true,
      },
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockGenerateLink).toHaveBeenCalledTimes(1)
  })

  it.each([
    [{ data: null, error: null }, 'zero-row counter update'],
    [{ data: null, error: { code: 'XX001' } }, 'counter update error'],
  ])('does not mint a session after %s (%s)', async (counterResult) => {
    mockUpdateCredential.mockResolvedValue(counterResult)

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockGenerateLink).not.toHaveBeenCalled()
  })

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
})
