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

const USER = { id: '11111111-1111-4111-8111-111111111111' }
const PASSKEY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const mockRpc = jest.fn()
const mockOrder = jest.fn()
const mockFrom = jest.fn(() => ({
  select: () => ({ eq: () => ({ order: mockOrder }) }),
}))
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

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

import { DELETE, GET } from '../route'

function request(body: unknown = { id: PASSKEY_ID }) {
  return {
    json: async () => body,
    headers: { get: () => null },
  } as unknown as import('next/server').NextRequest
}

function acknowledgement(status = 'deleted') {
  return {
    data: [
      {
        status,
        result_user_id: status === 'suspended' || status === 'missing' ? null : USER.id,
        result_passkey_id: status === 'suspended' || status === 'missing' ? null : PASSKEY_ID,
      },
    ],
    error: null,
  }
}

describe('/api/auth/webauthn/credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockResolvedValue(acknowledgement())
    mockOrder.mockResolvedValue({ data: [], error: null })
  })

  it('preserves the owner-scoped credential listing', async () => {
    mockOrder.mockResolvedValue({
      data: [
        {
          id: PASSKEY_ID,
          device_name: 'MacBook',
          created_at: '2026-07-29T00:00:00Z',
          last_used_at: null,
          transports: null,
        },
      ],
      error: null,
    })

    const response = await GET(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      passkeys: [
        {
          id: PASSKEY_ID,
          deviceName: 'MacBook',
          createdAt: '2026-07-29T00:00:00Z',
          lastUsedAt: null,
          transports: [],
        },
      ],
    })
    expect(mockFrom).toHaveBeenCalledWith('user_passkeys')
  })

  it('deletes through the exact active-profile authority and typed ACK', async () => {
    const response = await DELETE(request())

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ removed: true })
    expect(mockRpc).toHaveBeenCalledWith('delete_webauthn_credential_for_active_profile_atomic', {
      p_user_id: USER.id,
      p_passkey_id: PASSKEY_ID,
    })
  })

  it('returns not found only for an exact typed acknowledgement', async () => {
    mockRpc.mockResolvedValue(acknowledgement('not_found'))

    const response = await DELETE(request())

    expect(response.status).toBe(404)
  })

  it('rejects a suspension that wins after bearer admission', async () => {
    mockRpc.mockResolvedValue(acknowledgement('suspended'))

    const response = await DELETE(request())

    expect(response.status).toBe(403)
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
        data: [{ ...acknowledgement('not_found').data[0], result_passkey_id: null }],
        error: null,
      },
      'unbound not-found result',
    ],
  ])('fails closed for an invalid deletion acknowledgement (%s: %s)', async (result) => {
    mockRpc.mockResolvedValue(result)

    const response = await DELETE(request())

    expect(response.status).toBe(500)
  })

  it('rejects malformed identifiers before mutation', async () => {
    const response = await DELETE(request({ id: 'not-a-uuid' }))

    expect(response.status).toBe(400)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('contains no direct credential-table deletion', () => {
    const source = readFileSync(
      join(process.cwd(), 'app/api/auth/webauthn/credentials/route.ts'),
      'utf8'
    )

    expect(source).not.toMatch(/\.from\(['"]user_passkeys['"]\)[\s\S]*?\.delete\(/)
  })
})
