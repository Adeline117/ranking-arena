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

const mockVerifyRegistrationResponse = jest.fn()
jest.mock('@simplewebauthn/server', () => ({
  verifyRegistrationResponse: (...args: unknown[]) => mockVerifyRegistrationResponse(...args),
}))

const mockFromBuffer = jest.fn()
jest.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: { fromBuffer: (...args: unknown[]) => mockFromBuffer(...args) },
}))

const mockConsumeChallenge = jest.fn()
jest.mock('@/lib/auth/webauthn', () => ({
  consumeRegistrationChallenge: (...args: unknown[]) => mockConsumeChallenge(...args),
  getWebAuthnConfig: () => ({ rpID: 'www.arenafi.org', origin: 'https://www.arenafi.org' }),
}))

const USER = { id: '11111111-1111-4111-8111-111111111111' }
const PASSKEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const mockRpc = jest.fn()
const mockSupabase = { rpc: (...args: unknown[]) => mockRpc(...args) }

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (
      handler: (context: {
        user: typeof USER
        supabase: typeof mockSupabase
        request: unknown
      }) => unknown
    ) =>
    (request: unknown) =>
      handler({ user: USER, supabase: mockSupabase, request }),
}))

jest.mock('@/lib/api/response', () => ({
  badRequest: (message: string) => ({ status: 400, json: async () => ({ error: message }) }),
  serverError: (message: string) => ({ status: 500, json: async () => ({ error: message }) }),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }),
}))

import { POST } from '../route'

function request(body: unknown = { assertion: { id: 'browser-value' }, deviceName: 'MacBook' }) {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest
}

function acknowledgement(status = 'registered') {
  return {
    data: [
      {
        status,
        result_user_id: status === 'registered' ? USER.id : null,
        result_passkey_id: status === 'registered' ? PASSKEY_ID : null,
        result_credential_id: status === 'registered' ? 'verified-credential' : null,
      },
    ],
    error: null,
  }
}

describe('POST /api/auth/webauthn/registration-verify', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockConsumeChallenge.mockResolvedValue('expected-challenge')
    mockFromBuffer.mockReturnValue('dmVyaWZpZWQtcHVibGljLWtleQ')
    mockVerifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'verified-credential',
          publicKey: new Uint8Array([1, 2, 3]),
          counter: 7,
          transports: ['internal', 'hybrid'],
        },
      },
    })
    mockRpc.mockResolvedValue(acknowledgement())
  })

  it('registers exactly the server-verified canonical credential fields', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ verified: true })
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'expected-challenge',
        expectedOrigin: 'https://www.arenafi.org',
        expectedRPID: 'www.arenafi.org',
        requireUserVerification: true,
      })
    )
    expect(mockRpc).toHaveBeenCalledWith('register_webauthn_credential_for_active_profile_atomic', {
      p_user_id: USER.id,
      p_credential_id: 'verified-credential',
      p_public_key: 'dmVyaWZpZWQtcHVibGljLWtleQ',
      p_counter: 7,
      p_transports: ['internal', 'hybrid'],
      p_device_name: 'MacBook',
    })
  })

  it('rejects an expired challenge before verification or mutation', async () => {
    mockConsumeChallenge.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(400)
    expect(mockVerifyRegistrationResponse).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([-1, Number.MAX_SAFE_INTEGER + 1, 1.5])(
    'rejects an invalid server-verified counter before persistence: %s',
    async (counter) => {
      mockVerifyRegistrationResponse.mockResolvedValue({
        verified: true,
        registrationInfo: {
          credential: {
            id: 'verified-credential',
            publicKey: new Uint8Array([1, 2, 3]),
            counter,
          },
        },
      })

      const response = await POST(request())

      expect(response.status).toBe(500)
      expect(mockRpc).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['suspended', 403],
    ['conflict', 409],
  ])('maps a typed %s lifecycle acknowledgement to %s', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue(acknowledgement(status))

    const response = await POST(request())

    expect(response.status).toBe(expectedStatus)
  })

  it.each([
    [{ data: null, error: { code: 'XX001' } }, 'database error'],
    [{ data: [], error: null }, 'empty acknowledgement'],
    [
      { data: [acknowledgement().data[0], acknowledgement().data[0]], error: null },
      'multiple rows',
    ],
    [acknowledgement('missing'), 'missing account'],
    [
      {
        data: [{ ...acknowledgement().data[0], result_user_id: 'other-user' }],
        error: null,
      },
      'wrong subject',
    ],
    [
      {
        data: [{ ...acknowledgement().data[0], result_credential_id: 'browser-value' }],
        error: null,
      },
      'wrong credential',
    ],
    [
      {
        data: [{ ...acknowledgement().data[0], result_passkey_id: 'not-a-uuid' }],
        error: null,
      },
      'invalid passkey identity',
    ],
  ])('fails closed for an invalid atomic acknowledgement (%s: %s)', async (result) => {
    mockRpc.mockResolvedValue(result)

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it('contains no direct credential-table mutation', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/auth/webauthn/registration-verify/route.ts'),
      'utf8'
    )
    const optionsSource = readFileSync(
      join(process.cwd(), 'app/api/auth/webauthn/registration-options/route.ts'),
      'utf8'
    )

    expect(source).not.toMatch(/\.from\(['"]user_passkeys['"]\)/)
    expect(source).not.toContain('.insert(')
    expect(source).toContain('requireUserVerification: true')
    expect(optionsSource).toContain("residentKey: 'required'")
    expect(optionsSource).toContain("userVerification: 'required'")
  })
})
