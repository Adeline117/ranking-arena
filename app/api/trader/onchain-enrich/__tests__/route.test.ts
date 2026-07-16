const mockRpc = jest.fn()
const mockEnrich = jest.fn()

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number } = {}) => ({
      status: init.status ?? 200,
      json: async () => body,
    }),
  },
}))

jest.mock('@/lib/supabase/server', () => ({
  getSupabaseAdmin: () => ({ rpc: (...args: unknown[]) => mockRpc(...args) }),
}))

jest.mock('@/lib/utils/rate-limit', () => ({
  checkRateLimit: jest.fn().mockResolvedValue(null),
  RateLimitPresets: { sensitive: {} },
}))

jest.mock('@/lib/ingest/onchain/enrich', () => ({
  chainForSource: () => 'solana',
  enrichWeb3Wallet: (...args: unknown[]) => mockEnrich(...args),
  enrichmentExtras: jest.fn(() => ({ onchain_quality: { schema_version: 1 } })),
  onchainFetchBudget: jest.fn(() => ({ maxSigs: 150 })),
  scoreEligibleWinRate: jest.fn(() => null),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn() }),
}))

import type { NextRequest } from 'next/server'
import { POST } from '../route'

function request(): NextRequest {
  return {
    json: jest.fn().mockResolvedValue({
      source: 'okx_web3_solana',
      exchangeTraderId: 'SolanaWallet1111111111111111111111111111111',
    }),
  } as unknown as NextRequest
}

describe('/api/trader/onchain-enrich quality-aware freshness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockEnrich.mockResolvedValue({
      realizedPnlUsd: 10,
      unrealizedPnlUsd: 2,
      winRate: null,
      tokensTraded: 1,
    })
  })

  it('does not skip a recent legacy row that lacks quality schema v1', async () => {
    mockRpc
      .mockResolvedValueOnce({
        data: { extras: { onchain_enriched_at: new Date().toISOString() } },
        error: null,
      })
      .mockResolvedValueOnce({ data: 1, error: null })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ status: 'enriched', rows: 1 })
    expect(mockEnrich).toHaveBeenCalledTimes(1)
  })

  it('skips only a recent row with the current quality schema', async () => {
    mockRpc.mockResolvedValueOnce({
      data: {
        extras: {
          onchain_enriched_at: new Date().toISOString(),
          onchain_quality: {
            schema_version: 1,
            methodology: 'wallet-balance-delta-average-cost',
            methodology_version: '1.0.0',
          },
        },
      },
      error: null,
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'fresh', skipped: true })
    expect(mockEnrich).not.toHaveBeenCalled()
    expect(mockRpc).toHaveBeenCalledTimes(1)
  })
})
