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

const mockGetAuthUser = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
jest.mock('@/lib/supabase/server', () => ({
  getAuthUser: (...args: unknown[]) => mockGetAuthUser(...args),
  getSupabaseAdmin: () => mockGetSupabaseAdmin(),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

import { POST } from '../route'

const USER = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'user@example.com',
}
const WALLET = '0x1111111111111111111111111111111111111111'
const mockRpc = jest.fn()

function request() {
  return { headers: { get: () => null } } as unknown as import('next/server').NextRequest
}

function acknowledgement(status: string, releasedWallet: string | null = WALLET) {
  return {
    data: [
      {
        status,
        result_user_id: status === 'unbound' || status === 'already_unbound' ? USER.id : null,
        released_wallet_address: status === 'unbound' ? releasedWallet : null,
      },
    ],
    error: null,
  }
}

describe('POST /api/auth/siwe/unlink', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockGetAuthUser.mockResolvedValue(USER)
    mockRpc.mockResolvedValue(acknowledgement('unbound'))
    mockGetSupabaseAdmin.mockReturnValue({ rpc: mockRpc })
  })

  it('returns a rate-limit response before authentication or mutation', async () => {
    const limited = { status: 429, json: async () => ({ error: 'limited' }) }
    mockCheckRateLimit.mockResolvedValue(limited)

    await expect(POST(request())).resolves.toBe(limited)
    expect(mockGetAuthUser).not.toHaveBeenCalled()
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('requires an active authenticated account', async () => {
    mockGetAuthUser.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(mockGetSupabaseAdmin).not.toHaveBeenCalled()
  })

  it('does not unlink the sole credential of a wallet-only account', async () => {
    mockGetAuthUser.mockResolvedValue({ ...USER, email: `${WALLET}@wallet.arena` })

    const response = await POST(request())

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each(['unbound', 'already_unbound'])(
    'accepts the exact idempotent database acknowledgement: %s',
    async (status) => {
      mockRpc.mockResolvedValue(acknowledgement(status))

      const response = await POST(request())

      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ success: true })
      expect(mockRpc).toHaveBeenCalledWith('unbind_siwe_wallet_for_active_profile_atomic', {
        p_user_id: USER.id,
      })
    }
  )

  it('rejects a lifecycle suspension that wins after bearer admission', async () => {
    mockRpc.mockResolvedValue(acknowledgement('suspended'))

    const response = await POST(request())

    expect(response.status).toBe(403)
  })

  it('fails closed on a database error', async () => {
    mockRpc.mockResolvedValue({ data: null, error: { code: 'XX001' } })

    const response = await POST(request())

    expect(response.status).toBe(503)
  })

  it.each([
    [{ data: [], error: null }, 'empty acknowledgement'],
    [
      {
        data: [acknowledgement('unbound').data[0], acknowledgement('unbound').data[0]],
        error: null,
      },
      'multiple rows',
    ],
    [acknowledgement('missing'), 'missing profile'],
    [
      {
        data: [
          {
            ...acknowledgement('unbound').data[0],
            result_user_id: '22222222-2222-4222-8222-222222222222',
          },
        ],
        error: null,
      },
      'wrong subject',
    ],
  ])('fails closed for an invalid atomic acknowledgement (%s: %s)', async (result) => {
    mockRpc.mockResolvedValue(result)

    const response = await POST(request())

    expect(response.status).toBe(503)
  })

  it('contains no service-role profile table mutation', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const source = fs.readFileSync(
      path.join(process.cwd(), 'app/api/auth/siwe/unlink/route.ts'),
      'utf8'
    )

    expect(source).not.toMatch(/\.from\(['"]user_profiles['"]\)/)
    expect(source).not.toMatch(/\.update\(\{ wallet_address: null \}\)/)
  })
})
