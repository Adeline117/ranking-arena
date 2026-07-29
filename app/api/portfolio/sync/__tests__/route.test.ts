jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number

    constructor(body: unknown, init: { status?: number } = {}) {
      this._body = body
      this.status = init.status ?? 200
    }

    async json() {
      return this._body
    }

    static json(body: unknown, init?: { status?: number }) {
      return new MockNextResponse(body, init)
    }
  }

  class MockNextRequest {
    url: string
    nextUrl: URL
    private readonly body: unknown

    constructor(url: string, init: { body?: unknown } = {}) {
      this.url = url
      this.nextUrl = new URL(url)
      this.body = init.body
    }

    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

const mockRequireAuth = jest.fn()
const mockCheckRateLimit = jest.fn()
const mockGetSupabaseAdmin = jest.fn()
const mockFrom = jest.fn()
const mockRpc = jest.fn()
const mockSyncExchangePortfolio = jest.fn()

jest.mock('@/lib/api', () => {
  const { NextResponse } = require('next/server')
  return {
    getSupabaseAdmin: () => mockGetSupabaseAdmin(),
    requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
    RateLimitPresets: { write: {} },
    success: (data: unknown, status = 200) => NextResponse.json({ data }, { status }),
    handleError: () => NextResponse.json({ error: 'Internal error' }, { status: 500 }),
  }
})

jest.mock('@/lib/portfolio/exchange-sync', () => ({
  syncExchangePortfolio: (...args: unknown[]) => mockSyncExchangePortfolio(...args),
}))

jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

const USER_ID = '11111111-1111-4111-8111-111111111111'
const PORTFOLIO_ID = '22222222-2222-4222-8222-222222222222'
const SYNCED_AT = '2026-07-29T12:34:56.789Z'

const portfolio = {
  id: PORTFOLIO_ID,
  exchange: 'bybit',
  api_key_encrypted: 'encrypted-key',
  api_secret_encrypted: 'encrypted-secret',
  api_passphrase_encrypted: null,
}

const completeSnapshot = {
  ok: true as const,
  positions: [
    {
      portfolio_id: PORTFOLIO_ID,
      symbol: 'BTC/USDT:USDT',
      side: 'long' as const,
      entry_price: 100,
      mark_price: 101,
      size: 2,
      pnl: 2,
      pnl_pct: 1,
      leverage: 3,
      updated_at: SYNCED_AT,
    },
  ],
  equity: 500,
  pnl: 2,
  pnlPct: 0.4,
  syncedAt: SYNCED_AT,
}

function request() {
  return new NextRequest('http://localhost/api/portfolio/sync', {
    body: { portfolio_id: PORTFOLIO_ID },
  })
}

function portfolioQuery() {
  const query: Record<string, jest.Mock> = {}
  query.select = jest.fn(() => query)
  query.eq = jest.fn(() => query)
  query.single = jest.fn().mockResolvedValue({ data: portfolio, error: null })
  return query
}

function claimed(generation = 1) {
  return {
    data: {
      status: 'claimed',
      portfolio_id: PORTFOLIO_ID,
      generation,
    },
    error: null,
  }
}

function published(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      status: 'published',
      portfolio_id: PORTFOLIO_ID,
      generation: 1,
      position_count: completeSnapshot.positions.length,
      pruned_count: 0,
      synced_at: SYNCED_AT,
      ...overrides,
    },
    error: null,
  }
}

describe('POST /api/portfolio/sync atomic publication boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCheckRateLimit.mockResolvedValue(null)
    mockRequireAuth.mockResolvedValue({ id: USER_ID })
    mockGetSupabaseAdmin.mockReturnValue({ from: mockFrom, rpc: mockRpc })
    mockFrom.mockReturnValue(portfolioQuery())
    mockSyncExchangePortfolio.mockResolvedValue(completeSnapshot)
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_portfolio_sync_generation_atomic') return Promise.resolve(claimed())
      if (name === 'publish_portfolio_sync_atomic') return Promise.resolve(published())
      throw new Error(`unexpected RPC ${name}`)
    })
  })

  it('claims before fetching and publishes positions plus equity through one RPC', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'claim_portfolio_sync_generation_atomic', {
      p_actor_id: USER_ID,
      p_portfolio_id: PORTFOLIO_ID,
    })
    expect(mockRpc.mock.invocationCallOrder[0]).toBeLessThan(
      mockSyncExchangePortfolio.mock.invocationCallOrder[0]
    )
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'publish_portfolio_sync_atomic', {
      p_actor_id: USER_ID,
      p_portfolio_id: PORTFOLIO_ID,
      p_generation: 1,
      p_synced_at: SYNCED_AT,
      p_positions: [
        {
          symbol: 'BTC/USDT:USDT',
          side: 'long',
          entry_price: 100,
          mark_price: 101,
          size: 2,
          pnl: 2,
          pnl_pct: 1,
          leverage: 3,
        },
      ],
      p_total_equity: 500,
      p_total_pnl: 2,
      p_total_pnl_pct: 0.4,
    })
    expect(mockFrom).toHaveBeenCalledTimes(1)
  })

  it('publishes an authoritative zero-position, zero-equity snapshot', async () => {
    mockSyncExchangePortfolio.mockResolvedValue({
      ...completeSnapshot,
      positions: [],
      equity: 0,
      pnl: 0,
      pnlPct: 0,
    })
    mockRpc.mockImplementation((name: string) => {
      if (name === 'claim_portfolio_sync_generation_atomic') return Promise.resolve(claimed())
      if (name === 'publish_portfolio_sync_atomic') {
        return Promise.resolve(published({ position_count: 0 }))
      }
      throw new Error(`unexpected RPC ${name}`)
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenLastCalledWith(
      'publish_portfolio_sync_atomic',
      expect.objectContaining({
        p_positions: [],
        p_total_equity: 0,
        p_total_pnl: 0,
        p_total_pnl_pct: 0,
      })
    )
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'claim failed' } }],
    ['null result', { data: null, error: null }],
    [
      'zero generation',
      {
        data: { status: 'claimed', portfolio_id: PORTFOLIO_ID, generation: 0 },
        error: null,
      },
    ],
    ['unknown status', { data: { status: 'ok' }, error: null }],
  ])('fails closed on a %s claim response', async (_label, claimResult) => {
    mockRpc.mockResolvedValueOnce(claimResult)

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockSyncExchangePortfolio).not.toHaveBeenCalled()
  })

  it('does not fetch after the generation authority reports no owned row', async () => {
    mockRpc.mockResolvedValueOnce({ data: { status: 'not_found' }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(404)
    expect(mockSyncExchangePortfolio).not.toHaveBeenCalled()
  })

  it('never invokes publication after an incomplete exchange fetch', async () => {
    mockSyncExchangePortfolio.mockResolvedValue({ ok: false, reason: 'exchange_error' })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['database error', { data: null, error: { code: 'XX000', message: 'publish failed' } }],
    ['null result', { data: null, error: null }],
    ['unknown status', { data: { status: 'ok' }, error: null }],
  ])('does not acknowledge a %s publication response', async (_label, publicationResult) => {
    mockRpc.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(publicationResult)

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it.each([
    ['portfolio', { portfolio_id: '33333333-3333-4333-8333-333333333333' }],
    ['generation', { generation: 2 }],
    ['row count', { position_count: 0 }],
    ['timestamp', { synced_at: '2026-07-29T12:34:57.000Z' }],
  ])('rejects a publication ACK with a mismatched %s', async (_label, override) => {
    mockRpc.mockResolvedValueOnce(claimed()).mockResolvedValueOnce(published(override))

    const response = await POST(request())

    expect(response.status).toBe(500)
  })

  it('reports an older overlapping request as superseded, never as synced', async () => {
    mockRpc.mockResolvedValueOnce(claimed()).mockResolvedValueOnce({
      data: {
        status: 'superseded',
        generation: 1,
        current_generation: 2,
      },
      error: null,
    })

    const response = await POST(request())
    const body = await response.json()

    expect(response.status).toBe(409)
    expect(body).toEqual({
      data: {
        synced: false,
        reason: 'superseded',
        message: 'A newer portfolio sync is already in progress.',
        portfolio_id: PORTFOLIO_ID,
      },
    })
  })
})
