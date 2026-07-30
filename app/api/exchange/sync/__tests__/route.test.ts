jest.mock('next/server', () => {
  class MockNextResponse {
    _body: unknown
    status: number
    headers = new Map<string, string>()
    constructor(body?: unknown, init: { status?: number } = {}) {
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
    headers = new Map<string, string>()
    method: string
    private readonly body: unknown
    constructor(url: string, init: { method?: string; body?: unknown } = {}) {
      this.url = url
      this.nextUrl = new URL(url)
      this.method = init.method ?? 'POST'
      this.body = init.body
    }
    async json() {
      return this.body
    }
  }

  return { NextRequest: MockNextRequest, NextResponse: MockNextResponse }
})

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))

const mockUserId = '11111111-1111-4111-8111-111111111111'
const CONNECTION_ID = '22222222-2222-4222-8222-222222222222'
const mockRpc = jest.fn()

jest.mock('@/lib/api/middleware', () => ({
  withAuth: (handler: Function) => async (request: unknown) => {
    try {
      return await handler({
        user: { id: mockUserId },
        request,
        supabase: null,
        version: { current: 'v1' },
      })
    } catch {
      const { NextResponse } = require('next/server')
      return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
    }
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: jest.fn(() => ({ rpc: (...args: unknown[]) => mockRpc(...args) })),
}))

jest.mock('@/lib/exchange', () => ({
  SUPPORTED_EXCHANGES: ['binance', 'bybit', 'bitget', 'mexc', 'coinex', 'htx'],
}))

const mockDecrypt = jest.fn((ciphertext: string) => `plain:${ciphertext}`)
jest.mock('@/lib/exchange/encryption', () => ({
  decrypt: (ciphertext: string) => mockDecrypt(ciphertext),
}))

const mockGetBinanceAccount = jest.fn()
const mockGetBinanceTrades = jest.fn()
const mockCalculateBinanceStats = jest.fn()
jest.mock('@/lib/exchange/binance', () => ({
  getBinanceAccount: (...args: unknown[]) => mockGetBinanceAccount(...args),
  getBinanceTrades: (...args: unknown[]) => mockGetBinanceTrades(...args),
  calculateTradingStats: (...args: unknown[]) => mockCalculateBinanceStats(...args),
}))
jest.mock('@/lib/exchange/bybit', () => ({
  getBybitAccount: jest.fn(),
  getBybitTrades: jest.fn(),
  calculateBybitTradingStats: jest.fn(),
}))
jest.mock('@/lib/exchange/bitget', () => ({
  getBitgetAccount: jest.fn(),
  getBitgetTrades: jest.fn(),
  calculateBitgetTradingStats: jest.fn(),
}))
jest.mock('@/lib/exchange/mexc', () => ({
  getMexcAccount: jest.fn(),
  getMexcTrades: jest.fn(),
  calculateMexcTradingStats: jest.fn(),
}))
jest.mock('@/lib/exchange/coinex', () => ({
  getCoinexAccount: jest.fn(),
  getCoinexTrades: jest.fn(),
  calculateCoinexTradingStats: jest.fn(),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: jest.fn(() => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() })),
  logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
  captureError: jest.fn(),
  captureMessage: jest.fn(),
}))

import { NextRequest } from 'next/server'
import { POST } from '../route'

function claimResult() {
  return {
    status: 'claimed',
    user_id: mockUserId,
    exchange: 'binance',
    connection_id: CONNECTION_ID,
    generation: 7,
    api_key_encrypted: 'api-cipher',
    api_secret_encrypted: 'secret-cipher',
    passphrase_encrypted: null,
    legacy_access_token_encrypted: null,
  }
}

function finishResult(status: 'success' | 'error' = 'success') {
  return {
    status: 'recorded',
    user_id: mockUserId,
    connection_id: CONNECTION_ID,
    generation: 7,
    sync_status: status,
    synced_at: '2026-07-29T12:00:00Z',
  }
}

function request(exchange = 'binance') {
  return new NextRequest('http://localhost/api/exchange/sync', {
    method: 'POST',
    body: { exchange },
  })
}

describe('POST /api/exchange/sync generation fence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'claim_exchange_api_sync_atomic') {
        return { data: claimResult(), error: null }
      }
      return { data: finishResult(), error: null }
    })
    mockGetBinanceAccount.mockResolvedValue({})
    mockGetBinanceTrades.mockResolvedValue([])
    mockCalculateBinanceStats.mockReturnValue({
      totalTrades: 0,
      avgProfit: 0,
      avgLoss: 0,
      profitableTradesPct: 0,
      tradesPerWeek: 0,
    })
  })

  it('returns stats only after the claimed generation is recorded', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual(expect.objectContaining({ success: true }))
    expect(mockRpc).toHaveBeenNthCalledWith(1, 'claim_exchange_api_sync_atomic', {
      p_user_id: mockUserId,
      p_exchange: 'binance',
    })
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'finish_exchange_api_sync_atomic', {
      p_user_id: mockUserId,
      p_connection_id: CONNECTION_ID,
      p_generation: 7,
      p_succeeded: true,
      p_error: null,
    })
    expect(mockGetBinanceTrades.mock.invocationCallOrder[0]).toBeLessThan(
      mockRpc.mock.invocationCallOrder[1]
    )
  })

  it('does not call the exchange for a suspended lifecycle claim', async () => {
    mockRpc.mockResolvedValue({ data: { status: 'suspended' }, error: null })

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(mockGetBinanceAccount).not.toHaveBeenCalled()
  })

  it('does not return stale stats when credential rotation supersedes the claim', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'claim_exchange_api_sync_atomic') {
        return { data: claimResult(), error: null }
      }
      return { data: { status: 'superseded', current_generation: 8 }, error: null }
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.success).not.toBe(true)
  })

  it('records an exchange failure only against the claimed generation', async () => {
    mockGetBinanceAccount.mockRejectedValue(new Error('provider unavailable'))
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'claim_exchange_api_sync_atomic') {
        return { data: claimResult(), error: null }
      }
      return { data: finishResult('error'), error: null }
    })

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenNthCalledWith(2, 'finish_exchange_api_sync_atomic', {
      p_user_id: mockUserId,
      p_connection_id: CONNECTION_ID,
      p_generation: 7,
      p_succeeded: false,
      p_error: 'provider unavailable',
    })
  })

  it('does not report a zero-trade success for an unimplemented exchange client', async () => {
    mockRpc.mockImplementation(async (name: string) => {
      if (name === 'claim_exchange_api_sync_atomic') {
        return {
          data: { ...claimResult(), exchange: 'htx' },
          error: null,
        }
      }
      return { data: finishResult('error'), error: null }
    })

    const response = await POST(request('htx'))

    expect(response.status).toBe(500)
    expect(mockRpc).toHaveBeenNthCalledWith(
      2,
      'finish_exchange_api_sync_atomic',
      expect.objectContaining({
        p_succeeded: false,
        p_error: 'Live sync is not implemented for htx',
      })
    )
  })
})
