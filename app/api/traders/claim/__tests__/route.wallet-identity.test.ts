const mockIsTraderClaimed = jest.fn()
const mockSubmitClaim = jest.fn()
const mockGetUserClaimForTrader = jest.fn()
const mockGetUserVerifiedTrader = jest.fn()
const mockVerifyWalletOwnership = jest.fn()
const mockSendNotification = jest.fn()
const mockNotifyTraderClaim = jest.fn()

const mockLinkedOrder = jest.fn()
const mockLinkedEq = jest.fn(() => ({ order: mockLinkedOrder }))
const mockLinkedSelect = jest.fn(() => ({ eq: mockLinkedEq }))
const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table !== 'user_linked_traders') throw new Error(`Unexpected table: ${table}`)
    return { select: mockLinkedSelect }
  }),
}

function mockResponse(status: number, body: unknown) {
  return {
    status,
    json: async () => body,
  }
}

jest.mock('@/lib/api', () => ({
  getSupabaseAdmin: () => mockSupabase,
  requireAuth: jest.fn().mockResolvedValue({ id: 'user-1', email: 'user@example.com' }),
  success: (data: unknown) => mockResponse(200, { success: true, data }),
  handleError: (error: unknown) => {
    const typed = error as { message?: string; statusCode?: number }
    return mockResponse(typed.statusCode ?? 500, {
      success: false,
      error: typed.message ?? 'Internal server error',
    })
  },
  validateString: (
    value: unknown,
    options: { required?: boolean; maxLength?: number; fieldName?: string } = {}
  ) => {
    if (value === undefined || value === null || value === '') {
      if (options.required) {
        throw Object.assign(new Error(`${options.fieldName ?? 'field'} is required`), {
          statusCode: 400,
        })
      }
      return null
    }
    const result = String(value).trim()
    if (options.maxLength && result.length > options.maxLength) {
      throw new Error(`${options.fieldName ?? 'field'} is too long`)
    }
    return result
  },
  validateEnum: (value: unknown, allowed: readonly string[]) =>
    typeof value === 'string' && allowed.includes(value) ? value : null,
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {}, read: {} },
}))

jest.mock('@/lib/data/trader-claims', () => ({
  isTraderClaimed: (...args: unknown[]) => mockIsTraderClaimed(...args),
  submitClaim: (...args: unknown[]) => mockSubmitClaim(...args),
  getUserClaimForTrader: (...args: unknown[]) => mockGetUserClaimForTrader(...args),
  getUserVerifiedTrader: (...args: unknown[]) => mockGetUserVerifiedTrader(...args),
}))

jest.mock('@/lib/services/wallet-verification', () => ({
  verifyWalletOwnership: (...args: unknown[]) => mockVerifyWalletOwnership(...args),
}))

jest.mock('@/lib/services/claim-connection-proof', () => ({
  hasVerifiedClaimConnection: jest.fn(),
}))

jest.mock('@/lib/data/notifications', () => ({
  sendNotification: (...args: unknown[]) => mockSendNotification(...args),
}))

jest.mock('@/lib/notifications/activity-alerts', () => ({
  notifyTraderClaim: (...args: unknown[]) => mockNotifyTraderClaim(...args),
}))

jest.mock('@/lib/logger', () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}))

import type { NextRequest } from 'next/server'
import { GET, POST } from '../route'

const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
const canonicalEvm = checksumEvm.toLowerCase()
const solanaTrader = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const caseCollidingSolanaWallet = '7XKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
}

function getRequest(url: string): NextRequest {
  return { nextUrl: new URL(url) } as unknown as NextRequest
}

function walletClaim(traderId: string, walletAddress: unknown, source = 'hyperliquid') {
  return {
    trader_id: traderId,
    source,
    verification_method: 'signature',
    verification_data: {
      wallet_address: walletAddress,
      signature: '0xsigned',
      message: `I am claiming trader profile ${traderId} on Arena. Timestamp: ${Date.now()}`,
    },
  }
}

describe('GET /api/traders/claim identity scope', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetUserClaimForTrader.mockResolvedValue(null)
    mockGetUserVerifiedTrader.mockResolvedValue(null)
    mockLinkedOrder.mockResolvedValue({ data: [], error: null })
  })

  it('canonicalizes EVM query identity before the scoped lookup', async () => {
    const response = await GET(
      getRequest(`http://localhost/api/traders/claim?trader_id=${checksumEvm}&source=HYPERLIQUID`)
    )

    expect(response.status).toBe(200)
    expect(mockGetUserClaimForTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      canonicalEvm,
      'hyperliquid'
    )
  })

  it('preserves exact Solana Base58 case in the scoped lookup', async () => {
    const response = await GET(
      getRequest(`http://localhost/api/traders/claim?trader_id=${solanaTrader}&source=drift`)
    )

    expect(response.status).toBe(200)
    expect(mockGetUserClaimForTrader).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      solanaTrader,
      'drift'
    )
  })

  it('requires both identity parameters before querying claim history', async () => {
    const response = await GET(getRequest('http://localhost/api/traders/claim?trader_id=trader-a'))

    expect(response.status).toBe(400)
    expect(mockGetUserClaimForTrader).not.toHaveBeenCalled()
    expect(mockSupabase.from).not.toHaveBeenCalled()
  })
})

describe('POST /api/traders/claim wallet identity boundary', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockIsTraderClaimed.mockResolvedValue(false)
    mockVerifyWalletOwnership.mockResolvedValue({
      verified: true,
      wallet_address: canonicalEvm,
      chain: 'evm',
      message: 'verified',
    })
    mockSubmitClaim.mockResolvedValue({
      id: 'claim-1',
      user_id: 'user-1',
      trader_id: canonicalEvm,
      source: 'hyperliquid',
      verification_method: 'signature',
      verification_data: { wallet_address: canonicalEvm },
      status: 'reviewing',
      reject_reason: null,
      reviewed_by: null,
      reviewed_at: null,
      verified_at: null,
      created_at: '2026-07-16T00:00:00.000Z',
      updated_at: '2026-07-16T00:00:00.000Z',
    })
  })

  it('uses lowercase EVM identity for the claim check, verification, and insert', async () => {
    const response = await POST(request(walletClaim(checksumEvm, checksumEvm)))

    expect(response.status).toBe(200)
    expect(mockIsTraderClaimed).toHaveBeenCalledWith(mockSupabase, canonicalEvm, 'hyperliquid')
    expect(mockVerifyWalletOwnership).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      expect.objectContaining({
        wallet_address: checksumEvm,
        trader_key: canonicalEvm,
      })
    )
    expect(mockSubmitClaim).toHaveBeenCalledWith(
      mockSupabase,
      'user-1',
      expect.objectContaining({
        trader_id: canonicalEvm,
        source: 'hyperliquid',
        verification_data: expect.objectContaining({ wallet_address: canonicalEvm }),
      })
    )
  })

  it('cannot bypass an existing EVM claim with checksum case', async () => {
    mockIsTraderClaimed.mockResolvedValue(true)

    const response = await POST(request(walletClaim(checksumEvm, checksumEvm)))

    expect(response.status).toBe(400)
    expect(mockIsTraderClaimed).toHaveBeenCalledWith(mockSupabase, canonicalEvm, 'hyperliquid')
    expect(mockVerifyWalletOwnership).not.toHaveBeenCalled()
    expect(mockSubmitClaim).not.toHaveBeenCalled()
  })

  it('rejects a Solana key that matches only after lowercasing', async () => {
    const response = await POST(
      request(walletClaim(solanaTrader, caseCollidingSolanaWallet, 'drift'))
    )

    expect(response.status).toBe(400)
    expect(mockVerifyWalletOwnership).not.toHaveBeenCalled()
    expect(mockSubmitClaim).not.toHaveBeenCalled()
  })

  it('rejects non-string nested wallet fields as validation errors', async () => {
    const response = await POST(request(walletClaim(canonicalEvm, { address: canonicalEvm })))

    expect(response.status).toBe(400)
    expect(mockVerifyWalletOwnership).not.toHaveBeenCalled()
    expect(mockSubmitClaim).not.toHaveBeenCalled()
  })

  it('maps the database race winner to a stable validation response', async () => {
    mockSubmitClaim.mockRejectedValue({ code: '23505', message: 'active identity conflict' })

    const response = await POST(request(walletClaim(canonicalEvm, canonicalEvm)))

    expect(response.status).toBe(400)
    expect(mockSubmitClaim).toHaveBeenCalledTimes(1)
    expect(mockSendNotification).not.toHaveBeenCalled()
  })
})
