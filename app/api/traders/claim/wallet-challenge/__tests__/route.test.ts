import type { NextRequest } from 'next/server'

const mockRequireAuth = jest.fn()
const mockIsTraderClaimed = jest.fn()
const mockCreateWalletClaimChallenge = jest.fn()
const mockSupabase = { service: true }

function response(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    status,
    headers: new Map(Object.entries(headers)),
    json: async () => body,
  }
}

jest.mock('@/lib/api', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
  getSupabaseAdmin: () => mockSupabase,
  validateString: (
    value: unknown,
    options: { required?: boolean; maxLength?: number; fieldName?: string } = {}
  ) => {
    if (typeof value !== 'string' || !value.trim()) {
      if (options.required) {
        throw Object.assign(new Error(`${options.fieldName ?? 'field'} is required`), {
          statusCode: 400,
        })
      }
      return null
    }
    if (options.maxLength && value.length > options.maxLength) {
      throw Object.assign(new Error(`${options.fieldName ?? 'field'} is too long`), {
        statusCode: 400,
      })
    }
    return value.trim()
  },
  success: (data: unknown, status: number, headers: Record<string, string>) =>
    response(status, { success: true, data }, headers),
  handleError: (error: unknown) => {
    const typed = error as { message?: string; statusCode?: number }
    return response(typed.statusCode ?? 500, {
      success: false,
      error: typed.message ?? 'Internal server error',
    })
  },
}))

jest.mock('@/lib/data/trader-claims', () => ({
  isTraderClaimed: (...args: unknown[]) => mockIsTraderClaimed(...args),
}))

jest.mock('@/lib/services/wallet-verification', () => ({
  createWalletClaimChallenge: (...args: unknown[]) => mockCreateWalletClaimChallenge(...args),
}))

import { POST } from '../route'

const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
const canonicalEvm = checksumEvm.toLowerCase()

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

describe('POST /api/traders/claim/wallet-challenge', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockRequireAuth.mockResolvedValue({ id: 'user-1' })
    mockIsTraderClaimed.mockResolvedValue(false)
    mockCreateWalletClaimChallenge.mockResolvedValue({
      challenge_id: 'a'.repeat(64),
      message: 'server-issued-message',
      expires_at: '2026-08-03T12:05:00.000Z',
    })
  })

  it('issues a private challenge bound to the authenticated actor and canonical identity', async () => {
    const result = await POST(request({ trader_id: checksumEvm, source: 'HYPERLIQUID' }))

    expect(result.status).toBe(200)
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(mockIsTraderClaimed).toHaveBeenCalledWith(mockSupabase, canonicalEvm, 'hyperliquid')
    expect(mockCreateWalletClaimChallenge).toHaveBeenCalledWith(
      'user-1',
      'hyperliquid',
      canonicalEvm
    )
  })

  it('rejects a non-wallet source before challenge issuance', async () => {
    const result = await POST(request({ trader_id: '42', source: 'binance_futures' }))

    expect(result.status).toBe(400)
    expect(mockIsTraderClaimed).not.toHaveBeenCalled()
    expect(mockCreateWalletClaimChallenge).not.toHaveBeenCalled()
  })

  it('does not issue a challenge for an identity already in the review lifecycle', async () => {
    mockIsTraderClaimed.mockResolvedValue(true)

    const result = await POST(request({ trader_id: canonicalEvm, source: 'hyperliquid' }))

    expect(result.status).toBe(400)
    expect(mockCreateWalletClaimChallenge).not.toHaveBeenCalled()
  })

  it('fails closed when the nonce authority rejects issuance', async () => {
    mockCreateWalletClaimChallenge.mockRejectedValue(
      Object.assign(
        new Error('Wallet claim verification is temporarily unavailable. Please try again later.'),
        { code: 'SERVICE_UNAVAILABLE', statusCode: 503 }
      )
    )

    const result = await POST(request({ trader_id: canonicalEvm, source: 'hyperliquid' }))

    expect(result.status).toBe(503)
    expect(result.headers.get('Retry-After')).toBe('30')
    expect(result.headers.get('Cache-Control')).toBe('private, no-store')
    expect(await result.json()).toMatchObject({
      error: expect.stringContaining('temporarily unavailable'),
    })
  })
})
