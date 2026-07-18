const mockRpc = jest.fn()
const mockEnrich = jest.fn()
const mockIsQuotaExhausted = jest.fn()

jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => ({
      status: init.status ?? 200,
      headers: init.headers ?? {},
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

jest.mock('@/lib/ingest/onchain/solana-fetch', () => ({
  isQuotaExhausted: (...args: unknown[]) => mockIsQuotaExhausted(...args),
}))

jest.mock('@/lib/utils/logger', () => ({
  createLogger: () => ({ error: jest.fn(), warn: jest.fn() }),
}))

import type { NextRequest } from 'next/server'
import { clearOnchainProviderCapacityCircuit, POST } from '../route'

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
    clearOnchainProviderCapacityCircuit()
    mockIsQuotaExhausted.mockReturnValue(false)
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

  it('returns a retryable 503 and opens the chain circuit when provider capacity is exhausted', async () => {
    mockRpc.mockResolvedValue({ data: { extras: {} }, error: null })
    mockEnrich.mockRejectedValueOnce(new Error('Monthly capacity limit exceeded'))
    mockIsQuotaExhausted.mockReturnValue(true)

    const response = await POST(request())

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({
      error: 'provider_capacity_unavailable',
      retryAfterSeconds: 300,
    })
    expect(response.headers).toMatchObject({
      'Cache-Control': 'no-store',
      'Retry-After': '300',
    })
  })

  it('short-circuits another wallet on the same exhausted chain during cooldown', async () => {
    mockRpc.mockResolvedValue({ data: { extras: {} }, error: null })
    mockEnrich.mockRejectedValueOnce(new Error('max usage reached'))
    mockIsQuotaExhausted.mockReturnValue(true)

    const first = await POST(request())
    const second = await POST(request())

    expect(first.status).toBe(503)
    expect(second.status).toBe(503)
    expect(mockEnrich).toHaveBeenCalledTimes(1)
    await expect(second.json()).resolves.toMatchObject({
      error: 'provider_capacity_unavailable',
    })
  })

  it('keeps permanent enrichment failures observable as 500s', async () => {
    mockRpc.mockResolvedValue({ data: { extras: {} }, error: null })
    mockEnrich.mockRejectedValueOnce(new Error('parser invariant broken'))

    const response = await POST(request())

    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ error: 'enrich_failed' })
    expect(mockIsQuotaExhausted).toHaveBeenCalledWith('parser invariant broken')
  })
})
