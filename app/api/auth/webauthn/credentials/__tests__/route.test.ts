jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}))

const filters: Array<[string, unknown]> = []
let listResult: { data: unknown; error: unknown }
let deleteResult: { data: unknown; error: unknown }
const mockSupabase = {
  from: jest.fn(() => ({
    select: () => ({
      eq: (column: string, value: unknown) => {
        filters.push([column, value])
        return { order: async () => listResult }
      },
    }),
    delete: () => {
      const chain = {
        eq: (column: string, value: unknown) => {
          filters.push([column, value])
          return chain
        },
        select: async () => deleteResult,
      }
      return chain
    },
  })),
}
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

import { DELETE, GET } from '../route'

const PASSKEY_ID = '11111111-1111-4111-8111-111111111111'
const request = (body: unknown) => ({ json: async () => body }) as never

describe('/api/auth/webauthn/credentials', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    filters.length = 0
    listResult = { data: [], error: null }
    deleteResult = { data: [{ id: PASSKEY_ID }], error: null }
  })

  it('lists only the caller’s passkeys and never returns key material', async () => {
    listResult = {
      data: [
        {
          id: PASSKEY_ID,
          device_name: 'MacBook',
          created_at: '2026-11-01T00:00:00Z',
          last_used_at: null,
          transports: null,
        },
      ],
      error: null,
    }

    const body = await (await GET(request({}))).json()

    expect(filters).toEqual([['user_id', 'user-1']])
    expect(body).toEqual({
      passkeys: [
        {
          id: PASSKEY_ID,
          deviceName: 'MacBook',
          createdAt: '2026-11-01T00:00:00Z',
          lastUsedAt: null,
          transports: [],
        },
      ],
    })
    expect(JSON.stringify(body)).not.toMatch(/public_key|credential_id|counter/)
  })

  it('does not report a failed list as an empty one', async () => {
    listResult = { data: null, error: { message: 'db down' } }

    expect((await GET(request({}))).status).toBe(500)
  })

  it('scopes a delete to the caller so another user’s passkey cannot be removed', async () => {
    const response = await DELETE(request({ id: PASSKEY_ID }))

    expect(response.status).toBe(200)
    expect(filters).toEqual([
      ['id', PASSKEY_ID],
      ['user_id', 'user-1'],
    ])
  })

  it('answers 404 when the passkey is not the caller’s, 400 for a malformed id', async () => {
    deleteResult = { data: [], error: null }
    expect((await DELETE(request({ id: PASSKEY_ID }))).status).toBe(404)

    expect((await DELETE(request({ id: 'not-a-uuid' }))).status).toBe(400)
  })

  it('surfaces a failed delete as 500', async () => {
    deleteResult = { data: null, error: { message: 'db down' } }

    expect((await DELETE(request({ id: PASSKEY_ID }))).status).toBe(500)
  })
})
