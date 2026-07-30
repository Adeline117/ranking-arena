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

const mockUser = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'viewer-a@example.com',
}
const mockSupabaseRpc = jest.fn()
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
    rpc: (...args: unknown[]) => mockSupabaseRpc(...args),
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
  status: 'saved'
  exchange: string
  user_id: string
  connection_id: string
  generation: number
  verified: boolean
}

function atomicSaveResult(
  savedConnection: PersistedConnection | null = {
    status: 'saved',
    exchange: 'binance',
    user_id: mockUser.id,
    connection_id: '22222222-2222-4222-8222-222222222222',
    generation: 1,
    verified: true,
  },
  error: unknown = null
) {
  return { data: savedConnection, error }
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
    mockSupabaseRpc.mockResolvedValue(atomicSaveResult())
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
    expect(mockSupabaseRpc).toHaveBeenCalledWith(
      'upsert_exchange_api_connection_for_active_profile_atomic',
      {
        p_user_id: mockUser.id,
        p_exchange: 'binance',
        p_api_key_encrypted: 'encrypted:read-only-key',
        p_api_secret_encrypted: 'encrypted:read-only-secret',
        p_passphrase_encrypted: null,
        p_verified_uid: 'account-42',
        p_scope_permissions: ['read'],
      }
    )
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
    expect(mockSupabaseRpc).not.toHaveBeenCalled()
  })

  it('fails closed when the persisted connection acknowledgement is mismatched', async () => {
    mockSupabaseRpc.mockResolvedValue(
      atomicSaveResult({
        status: 'saved',
        exchange: 'binance',
        user_id: '33333333-3333-4333-8333-333333333333',
        connection_id: '22222222-2222-4222-8222-222222222222',
        generation: 1,
        verified: true,
      })
    )

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(500)
    expect(body.success).toBe(false)
    expect(body.error.message).toContain('failed to store credentials')
  })
})
