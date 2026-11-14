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
jest.mock('@simplewebauthn/server/helpers', () => ({
  isoBase64URL: { fromBuffer: jest.fn(() => 'cHVibGljLWtleQ==') },
}))

const mockConsumeChallenge = jest.fn()
const mockGetConfig = jest.fn()
jest.mock('@/lib/auth/webauthn', () => ({
  consumeRegistrationChallenge: (...args: unknown[]) => mockConsumeChallenge(...args),
  getWebAuthnConfig: (...args: unknown[]) => mockGetConfig(...args),
}))

const mockInsert = jest.fn()
const mockSupabase = { from: jest.fn(() => ({ insert: mockInsert })) }
jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => (request: unknown) =>
    handler({ user: { id: 'user-1' }, supabase: mockSupabase, request }),
}))
jest.mock('@/lib/api/response', () => ({
  badRequest: (message: string) => ({ status: 400, json: async () => ({ error: message }) }),
  serverError: (message: string) => ({ status: 500, json: async () => ({ error: message }) }),
}))
jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}))

import { POST } from '../route'

const request = (body: unknown) => ({ json: async () => body }) as never
const assertion = { id: 'cred-1', response: {} }

describe('POST /api/auth/webauthn/registration-verify', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetConfig.mockReturnValue({ rpID: 'arenafi.org', origin: 'https://www.arenafi.org' })
    mockConsumeChallenge.mockResolvedValue('challenge-1')
    mockVerifyRegistrationResponse.mockResolvedValue({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'cred-1',
          publicKey: new Uint8Array([1, 2]),
          counter: 0,
          transports: ['internal'],
        },
      },
    })
    mockInsert.mockResolvedValue({ error: null })
  })

  it('stores the verified credential for the authenticated user only', async () => {
    const response = await POST(request({ assertion, deviceName: '  MacBook  ' }))

    expect(response.status).toBe(200)
    expect(mockConsumeChallenge).toHaveBeenCalledWith('user-1')
    expect(mockVerifyRegistrationResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedChallenge: 'challenge-1',
        expectedOrigin: 'https://www.arenafi.org',
        expectedRPID: 'arenafi.org',
      })
    )
    expect(mockInsert).toHaveBeenCalledWith({
      user_id: 'user-1',
      credential_id: 'cred-1',
      public_key: 'cHVibGljLWtleQ==',
      counter: 0,
      transports: ['internal'],
      device_name: 'MacBook',
    })
  })

  it('rejects an unrecognized origin with 400 without spending the challenge', async () => {
    mockGetConfig.mockImplementation(() => {
      throw new Error('Unrecognized WebAuthn origin')
    })

    const response = await POST(request({ assertion }))

    expect(response.status).toBe(400)
    expect(mockConsumeChallenge).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it.each([
    ['an expired challenge', () => mockConsumeChallenge.mockResolvedValue(null)],
    [
      'a verification that throws',
      () => mockVerifyRegistrationResponse.mockRejectedValue(new Error('bad signature')),
    ],
    [
      'an unverified response',
      () => mockVerifyRegistrationResponse.mockResolvedValue({ verified: false }),
    ],
  ])('stores nothing for %s', async (_name, arrange) => {
    arrange()

    const response = await POST(request({ assertion }))

    expect(response.status).toBe(400)
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('reports an already-enrolled credential as a conflict, other failures as 500', async () => {
    mockInsert.mockResolvedValueOnce({ error: { code: '23505' } })
    expect((await POST(request({ assertion }))).status).toBe(409)

    mockInsert.mockResolvedValueOnce({ error: { code: 'XX000', message: 'db down' } })
    expect((await POST(request({ assertion }))).status).toBe(500)
  })

  it('rejects a malformed body before touching the challenge', async () => {
    const response = await POST(request({ assertion: 'not-an-object' }))

    expect(response.status).toBe(400)
    expect(mockConsumeChallenge).not.toHaveBeenCalled()
  })
})
