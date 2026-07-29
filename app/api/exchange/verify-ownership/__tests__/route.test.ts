jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers: Map<string, string>

    constructor(body?: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
      this.headers = new Map()
    }

    async json() {
      return this._body
    }

    static json(data: unknown, init?: { status?: number }) {
      return new MockNextResponse(data, init)
    }
  }

  class MockNextRequest {
    url: string
    method: string
    _body: unknown

    constructor(url: string, init?: { method?: string; body?: unknown }) {
      this.url = url
      this.method = init?.method ?? 'POST'
      this._body = init?.body
    }

    async json() {
      return this._body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockUser = { id: 'viewer-a', email: 'viewer-a@example.com' }
const mockSupabaseFrom = jest.fn()
const mockResolveTrader = jest.fn()
const mockResolveExchangeUid = jest.fn()
const mockIsCexVerifiable = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth:
    (handler: (context: Record<string, unknown>) => Promise<unknown>) => async (request: unknown) =>
      handler({ request, user: mockUser }),
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  }),
}))

jest.mock('@/lib/data/unified', () => ({
  resolveTrader: (...args: unknown[]) => mockResolveTrader(...args),
}))

jest.mock('@/lib/validators/exchange-uid-resolver', () => ({
  isCexVerifiable: (...args: unknown[]) => mockIsCexVerifiable(...args),
  resolveExchangeUid: (...args: unknown[]) => mockResolveExchangeUid(...args),
}))

jest.mock('@/lib/exchange/encryption', () => ({
  encrypt: (value: string) => `encrypted:${value}`,
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

type PersistedConnection = {
  exchange: string
  is_active: boolean
  user_id: string
  verified_uid: string
}

function connectionChain(
  savedConnection: PersistedConnection | null = {
    exchange: 'binance',
    is_active: true,
    user_id: mockUser.id,
    verified_uid: 'account-42',
  },
  error: unknown = null
) {
  const chain: Record<string, jest.Mock> = {}
  chain.upsert = jest.fn(() => chain)
  chain.select = jest.fn(() => chain)
  chain.single = jest.fn().mockResolvedValue({ data: savedConnection, error })
  return chain
}

function request(overrides: Record<string, unknown> = {}) {
  return new NextRequest('http://localhost/api/exchange/verify-ownership', {
    method: 'POST',
    body: {
      exchange: 'binance_futures',
      traderId: 'account-42',
      source: 'binance_futures',
      apiKey: 'read-only-key',
      apiSecret: 'read-only-secret',
      ...overrides,
    },
  })
}

describe('POST /api/exchange/verify-ownership identity contract', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsCexVerifiable.mockReturnValue(true)
    mockResolveTrader.mockResolvedValue({ traderKey: 'account-42' })
    mockResolveExchangeUid.mockResolvedValue({
      success: true,
      uid: 'account-42',
      isReadOnly: true,
      permissions: ['read'],
    })
    mockSupabaseFrom.mockReturnValue(connectionChain())
  })

  it('accepts a supported suffixed leaderboard source and persists its base connection', async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(200)
    expect(mockResolveTrader).toHaveBeenCalledWith(expect.anything(), {
      handle: 'account-42',
      platform: 'binance_futures',
    })
    expect(mockResolveExchangeUid).toHaveBeenCalledWith(
      'binance_futures',
      expect.objectContaining({ apiKey: 'read-only-key', apiSecret: 'read-only-secret' })
    )
    const chain = mockSupabaseFrom.mock.results[0]?.value
    expect(chain.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: mockUser.id,
        exchange: 'binance',
        verified_uid: 'account-42',
        is_active: true,
      }),
      { onConflict: 'user_id,exchange' }
    )
    expect(chain.select).toHaveBeenCalledWith('user_id, exchange, verified_uid, is_active')
    expect(body).toMatchObject({
      success: true,
      verified: true,
      uid: 'account-42',
      data: {
        viewerId: mockUser.id,
        exchange: 'binance',
        source: 'binance_futures',
        traderId: 'account-42',
        verifiedUid: 'account-42',
      },
    })
  })

  it('rejects an exchange that does not match the selected trader source', async () => {
    const response = await POST(request({ exchange: 'bybit' }))
    const body = await response.json()

    expect(response.status).toBe(400)
    expect(body.success).toBe(false)
    expect(mockResolveTrader).not.toHaveBeenCalled()
    expect(mockSupabaseFrom).not.toHaveBeenCalled()
  })

  it('fails closed when the persisted connection acknowledgement is mismatched', async () => {
    mockSupabaseFrom.mockReturnValue(
      connectionChain({
        exchange: 'binance',
        is_active: true,
        user_id: 'viewer-b',
        verified_uid: 'account-42',
      })
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error.message).toContain('failed to store credentials')
  })
})
