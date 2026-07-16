const mockIsTraderClaimed = jest.fn()
const mockVerifyWalletOwnership = jest.fn()
const mockInsert = jest.fn()
const mockSelect = jest.fn()
const mockSingle = jest.fn()
const mockSendNotification = jest.fn()
const mockNotifyTraderClaim = jest.fn()

const mockSupabase = {
  from: jest.fn((table: string) => {
    if (table !== 'trader_claims') throw new Error(`Unexpected table: ${table}`)
    return { insert: mockInsert }
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
      if (options.required) throw new Error(`${options.fieldName ?? 'field'} is required`)
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
  getUserClaim: jest.fn(),
  getUserVerifiedTrader: jest.fn(),
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
import { POST } from '../route'

const checksumEvm = '0xAbCdEf0123456789aBCdEf0123456789AbCdEf01'
const canonicalEvm = checksumEvm.toLowerCase()
const solanaTrader = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'
const caseCollidingSolanaWallet = '7XKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU'

function request(body: unknown): NextRequest {
  return { json: jest.fn().mockResolvedValue(body) } as unknown as NextRequest
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
    mockInsert.mockReturnValue({ select: mockSelect })
    mockSelect.mockReturnValue({ single: mockSingle })
    mockSingle.mockResolvedValue({
      data: { id: 'claim-1', trader_id: canonicalEvm },
      error: null,
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
    expect(mockInsert).toHaveBeenCalledWith(
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
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('rejects a Solana key that matches only after lowercasing', async () => {
    const response = await POST(
      request(walletClaim(solanaTrader, caseCollidingSolanaWallet, 'drift'))
    )

    expect(response.status).toBe(400)
    expect(mockVerifyWalletOwnership).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })

  it('rejects non-string nested wallet fields as validation errors', async () => {
    const response = await POST(request(walletClaim(canonicalEvm, { address: canonicalEvm })))

    expect(response.status).toBe(400)
    expect(mockVerifyWalletOwnership).not.toHaveBeenCalled()
    expect(mockInsert).not.toHaveBeenCalled()
  })
})
