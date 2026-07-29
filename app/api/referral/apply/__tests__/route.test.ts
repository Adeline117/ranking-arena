/** @jest-environment node */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockGetIdentifier = jest.fn()
const mockUser = {
  id: '11111111-1111-4111-8111-111111111111',
  app_metadata: { provider: 'google' },
}
const mockSupabase = {
  from: (...args: unknown[]) => mockFrom(...args),
  rpc: (...args: unknown[]) => mockRpc(...args),
}

jest.mock('next/server', () => {
  class MockNextResponse {
    status: number

    constructor(
      private readonly body: unknown,
      init: { status?: number } = {}
    ) {
      this.status = init.status ?? 200
    }

    async json() {
      return this.body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  return { NextResponse: MockNextResponse }
})

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => (request: unknown) =>
      handler({
        user: mockUser,
        supabase: mockSupabase,
        request,
      }),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  getIdentifier: (...args: unknown[]) => mockGetIdentifier(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  }),
}))

import { POST } from '../route'

const REFERRER_ID = '22222222-2222-4222-8222-222222222222'
const ATTRIBUTION_ID = '33333333-3333-4333-8333-333333333333'
const referrer = {
  id: REFERRER_ID,
  referral_code: 'alice-code',
  handle: 'alice',
}

type QueryResult = { data: unknown; error: unknown }

function referrerQuery(result: QueryResult): Record<string, jest.Mock> {
  const builder: Record<string, jest.Mock> = {}
  for (const method of ['select', 'or']) {
    builder[method] = jest.fn(() => builder)
  }
  builder.limit = jest.fn().mockResolvedValue(result)
  return builder
}

function request(body: unknown = { code: 'alice-code' }): Request {
  return {
    json: async () => body,
  } as Request
}

function successAck(status: 'applied' | 'already_applied' = 'applied') {
  return {
    data: {
      status,
      referred_id: mockUser.id,
      referrer_id: REFERRER_ID,
      attribution_id: ATTRIBUTION_ID,
      created: status === 'applied',
    },
    error: null,
  }
}

describe('POST /api/referral/apply atomic attribution boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockFrom.mockReturnValue(referrerQuery({ data: [referrer], error: null }))
    mockGetIdentifier.mockReturnValue('ip:device-bucket')
    mockRpc.mockResolvedValue(successAck())
  })

  it('binds the profile edge and reward attribution through one RPC', async () => {
    const response = await POST(request() as never)

    expect(response.status).toBe(200)
    expect(mockFrom).toHaveBeenCalledTimes(1)
    expect(mockFrom).toHaveBeenCalledWith('user_profiles')
    expect(mockRpc).toHaveBeenCalledWith('apply_referral_attribution_atomic', {
      p_referred_id: mockUser.id,
      p_referrer_id: REFERRER_ID,
      p_provider: 'google',
      p_signup_ip_hash: createHash('sha256').update('ip:device-bucket').digest('hex').slice(0, 32),
    })
    await expect(response.json()).resolves.toEqual({
      success: true,
      referrer_handle: 'alice',
      pending: true,
    })
  })

  it('treats an exact retry as idempotent success', async () => {
    mockRpc.mockResolvedValue(successAck('already_applied'))

    const response = await POST(request() as never)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ success: true, pending: true })
  })

  it('does not call the authority for an invalid, non-string, missing, or self referral', async () => {
    const invalid = await POST(request({ code: 'bad.code' }) as never)
    expect(invalid.status).toBe(400)

    const nonString = await POST(request({ code: 42 }) as never)
    expect(nonString.status).toBe(400)

    mockFrom.mockReturnValueOnce(referrerQuery({ data: [], error: null }))
    const missing = await POST(request() as never)
    expect(missing.status).toBe(404)

    mockFrom.mockReturnValueOnce(
      referrerQuery({ data: [{ ...referrer, id: mockUser.id }], error: null })
    )
    const self = await POST(request() as never)
    expect(self.status).toBe(400)

    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('surfaces a referrer lookup error instead of consuming attribution', async () => {
    mockFrom.mockReturnValue(
      referrerQuery({ data: null, error: { code: 'XX000', message: 'database unavailable' } })
    )

    const response = await POST(request() as never)

    expect(response.status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('fails closed on a null referrer query result without a database error', async () => {
    mockFrom.mockReturnValue(referrerQuery({ data: null, error: null }))

    const response = await POST(request() as never)

    expect(response.status).toBe(500)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it('rejects a referral_code/handle namespace collision instead of crediting arbitrarily', async () => {
    mockFrom.mockReturnValue(
      referrerQuery({
        data: [
          referrer,
          {
            id: '55555555-5555-4555-8555-555555555555',
            referral_code: null,
            handle: 'alice-code',
          },
        ],
        error: null,
      })
    )

    const response = await POST(request() as never)

    expect(response.status).toBe(409)
    expect(mockRpc).not.toHaveBeenCalled()
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'write failed' } }],
    ['null result', { data: null, error: null }],
    ['array result', { data: [], error: null }],
    ['unknown status', { data: { status: 'ok' }, error: null }],
    [
      'extra acknowledgement field',
      { data: { ...successAck().data, unexpected: true }, error: null },
    ],
    ['contradictory created flag', { data: { ...successAck().data, created: false }, error: null }],
    [
      'wrong referred identity',
      {
        data: {
          ...successAck().data,
          referred_id: '44444444-4444-4444-8444-444444444444',
        },
        error: null,
      },
    ],
    [
      'empty attribution identity',
      { data: { ...successAck().data, attribution_id: '' }, error: null },
    ],
  ])('fails closed on a %s RPC acknowledgement', async (_label, rpcResult) => {
    mockRpc.mockResolvedValue(rpcResult)

    const response = await POST(request() as never)

    expect(response.status).toBe(500)
  })

  it.each([
    ['conflict', 400],
    ['not_found', 404],
    ['invalid', 500],
    ['inconsistent', 500],
  ] as const)('maps the exact %s authority status', async (status, expectedStatus) => {
    mockRpc.mockResolvedValue({ data: { status }, error: null })

    const response = await POST(request() as never)

    expect(response.status).toBe(expectedStatus)
  })

  it('contains no direct profile or attribution mutation fallback', () => {
    const source = readFileSync(resolve(process.cwd(), 'app/api/referral/apply/route.ts'), 'utf8')

    expect(source).toContain("'apply_referral_attribution_atomic'")
    expect(source).not.toContain(".from('referral_attributions')")
    expect(source).not.toContain('.update({ referred_by:')
    expect(source).not.toContain('.insert({ referred_id:')
  })
})
