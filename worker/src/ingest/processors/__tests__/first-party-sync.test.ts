const mockQuery = jest.fn()
const mockPublishProfile = jest.fn()
const mockFetchAccount = jest.fn()
const mockCompute = jest.fn()
const mockDecrypt = jest.fn((value: string) => `plain:${value}`)
const mockValidateStats = jest.fn()
const mockGetSourceBySlug = jest.fn()
const mockCcxtConfigs: Record<string, unknown>[] = []

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: mockQuery }),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  validateStats: (...args: unknown[]) => mockValidateStats(...args),
}))
jest.mock('@/lib/ingest/first-party/fetch', () => ({
  fetchFirstPartyAccount: (...args: unknown[]) => mockFetchAccount(...args),
}))
jest.mock('@/lib/ingest/first-party/engine', () => ({
  computeFirstParty: (...args: unknown[]) => mockCompute(...args),
}))
jest.mock('@/lib/portfolio/exchange-sync', () => ({
  CCXT_ID: {
    binance: 'binance',
    bitget: 'bitget',
    bybit: 'bybit',
    gateio: 'gate',
    okx: 'okx',
  },
  GEO_BLOCKED: new Set(['binance', 'okx']),
  PASSPHRASE_REQUIRED: new Set(['bitget', 'okx']),
  makeProxyFetch: () => jest.fn(),
}))
jest.mock('@/lib/exchange/authorization-credentials', () => ({
  decryptAuthorizationCredential: (value: string) => mockDecrypt(value),
}))
jest.mock('ccxt', () => {
  class MockExchange {
    constructor(config: Record<string, unknown>) {
      mockCcxtConfigs.push(config)
    }
  }
  return {
    __esModule: true,
    default: {
      binance: MockExchange,
      bitget: MockExchange,
      bybit: MockExchange,
      gate: MockExchange,
      okx: MockExchange,
    },
    binance: MockExchange,
    bitget: MockExchange,
    bybit: MockExchange,
    gate: MockExchange,
    okx: MockExchange,
  }
})

import { processFirstPartySync } from '../first-party-sync'
import type { SourceJobLeaseAuthority } from '../../source-job-lease'

const AUTH = {
  id: 'auth-1',
  user_id: 'user-1',
  platform: 'bybit',
  trader_id: 'trader-1',
  encrypted_api_key: 'key-cipher',
  encrypted_api_secret: 'secret-cipher',
  encrypted_passphrase: null,
  status: 'active',
  last_sync_at: null,
  consecutive_failures: 0,
}

const LEASE_ERROR = new Error('[ingest] source-job lease ownership lost: first-party/auth-1')
const mockAssertLeaseOwned = jest.fn()
const mockRenewLease = jest.fn<Promise<void>, []>()
const SOURCE_LEASE = {
  proof: {
    contract: 'arena.ingest.source-job-lease-provenance@1',
    leaseId: 'lease-1',
    lane: 'first-party',
    scopeId: 'auth-1',
    ownerTokenSha256: 'a'.repeat(64),
  },
  assertOwned: () => mockAssertLeaseOwned(),
  renew: () => mockRenewLease(),
} satisfies SourceJobLeaseAuthority

function processAuthorization() {
  return processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never, SOURCE_LEASE)
}

function queueQueries(
  auth = AUTH,
  source: { slug: string; exchange_slug: string } = {
    slug: 'bybit_copytrade',
    exchange_slug: 'bybit',
  }
) {
  mockQuery
    .mockResolvedValueOnce({ rows: [auth] })
    .mockResolvedValueOnce({ rows: [source] })
    .mockResolvedValueOnce({ rows: [{ id: 99 }] })
    .mockResolvedValueOnce({ rows: [] })
}

describe('first-party sync processor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockCcxtConfigs.length = 0
    mockAssertLeaseOwned.mockReset()
    mockRenewLease.mockReset().mockResolvedValue(undefined)
    mockGetSourceBySlug.mockReset().mockResolvedValue({
      id: 7,
      slug: 'bybit_copytrade',
      product_type: 'futures',
    })
    mockDecrypt.mockImplementation((value: string) => `plain:${value}`)
    mockPublishProfile.mockResolvedValue(undefined)
    mockFetchAccount.mockResolvedValue({ equity: 100 })
    mockValidateStats.mockImplementation((stats: unknown) => ({ valid: stats, rejects: [] }))
    mockCompute.mockReturnValue({
      stats: [
        { timeframe: 7, roi: 5 },
        { timeframe: 30, roi: 8 },
        { timeframe: 90, roi: 12 },
      ],
      series: [{ timeframe: 90, metric: 'equity', points: [{ ts: 1, value: 100 }] }],
      snapshot: {
        equity: 100,
        balance: 90,
        unrealizedPnl: 10,
        netTransferCum: 0,
        currency: 'USDT',
      },
    })
  })

  it('publishes first-party data before marking the authorization successful', async () => {
    queueQueries()
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await processAuthorization()

    expect(result).toMatchObject({ ok: true, statsWritten: 3, seriesPoints: 1 })
    expect(mockPublishProfile).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'bybit_copytrade' }),
      99,
      expect.objectContaining({
        stats: [
          { timeframe: 7, roi: 5 },
          { timeframe: 30, roi: 8 },
          { timeframe: 90, roi: 12 },
        ],
      }),
      { fullSeries: true }
    )
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('arena.first_party_snapshots'))
    ).toBe(true)
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('last_sync_status = $2'), [
      'auth-1',
      'success',
      0,
      'active',
      'ok stats=3 rejects=0',
    ])
  })

  it.each([['binance_futures', 'futures', 'swap']])(
    'constructs %s from the registry exchange identity with the matching CCXT product type',
    async (platform, productType, defaultType) => {
      queueQueries({ ...AUTH, platform }, { slug: platform, exchange_slug: 'binance' })
      mockGetSourceBySlug.mockResolvedValue({
        id: 7,
        slug: platform,
        product_type: productType,
      })
      mockQuery.mockResolvedValue({ rows: [] })

      const result = await processAuthorization()

      expect(result.ok).toBe(true)
      expect(mockQuery.mock.calls[1]?.[1]).toEqual([platform, null])
      expect(mockCcxtConfigs).toHaveLength(1)
      expect(mockCcxtConfigs[0]).toMatchObject({ options: { defaultType } })
      expect(mockFetchAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ balanceSemantics: 'total_includes_unrealized' })
      )
    }
  )

  it('fails closed for spot sources whose holdings need asset valuation', async () => {
    queueQueries(
      { ...AUTH, platform: 'binance_spot' },
      { slug: 'binance_spot', exchange_slug: 'binance' }
    )
    mockGetSourceBySlug.mockResolvedValue({
      id: 7,
      slug: 'binance_spot',
      product_type: 'spot',
    })
    mockQuery.mockResolvedValue({ rows: [] })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processAuthorization()

    expect(result).toMatchObject({
      ok: false,
      detail: 'first-party sync unsupported for spot source',
    })
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockFetchAccount).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
  })

  it('resolves an exchange-level Binance authorization to its unique human futures source', async () => {
    queueQueries(
      { ...AUTH, platform: 'BINANCE' },
      { slug: 'binance_futures', exchange_slug: 'binance' }
    )
    mockGetSourceBySlug.mockResolvedValue({
      id: 7,
      slug: 'binance_futures',
      product_type: 'futures',
    })
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await processAuthorization()

    expect(result.ok).toBe(true)
    expect(mockQuery.mock.calls[1]?.[1]).toEqual(['binance', 'binance'])
    expect(mockCcxtConfigs[0]).toMatchObject({ options: { defaultType: 'swap' } })
  })

  it('maps the Arena gate exchange identity to the CCXT gate class', async () => {
    queueQueries({ ...AUTH, platform: 'gateio' }, { slug: 'gate_futures', exchange_slug: 'gate' })
    mockGetSourceBySlug.mockResolvedValue({
      id: 7,
      slug: 'gate_futures',
      product_type: 'futures',
    })
    mockQuery.mockResolvedValue({ rows: [] })

    const result = await processAuthorization()

    expect(result.ok).toBe(true)
    expect(mockCcxtConfigs).toHaveLength(1)
  })

  it('does not mark a sync successful when any required stats window fails validation', async () => {
    queueQueries()
    mockQuery.mockResolvedValue({ rows: [] })
    mockValidateStats.mockReturnValue({
      valid: [{ timeframe: 90, roi: 12 }],
      rejects: [{ reason: 'zod:invalid', payload: {} }],
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processAuthorization()

    expect(result).toMatchObject({
      ok: false,
      detail: 'first-party stats validation failed: valid=1 rejects=1',
    })
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('last_sync_status = $2'), [
      'auth-1',
      'error',
      1,
      'active',
      'first-party stats validation failed: valid=1 rejects=1',
    ])
  })

  it('fails closed instead of choosing an ambiguous source alias', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [AUTH] })
      .mockResolvedValueOnce({
        rows: [
          { slug: 'bybit_copytrade', exchange_slug: 'bybit' },
          { slug: 'bybit_shadow', exchange_slug: 'bybit' },
        ],
      })
      .mockResolvedValue({ rows: [] })

    const result = await processAuthorization()

    expect(result).toMatchObject({ ok: false, detail: 'ambiguous platform bybit' })
    expect(mockGetSourceBySlug).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('last_sync_status = $2'), [
      'auth-1',
      'error',
      1,
      'active',
      'ambiguous platform bybit',
    ])
  })

  it('does not publish or penalize the user after losing authorization lease ownership', async () => {
    queueQueries()
    mockQuery.mockResolvedValue({ rows: [] })
    mockRenewLease.mockImplementation(async () => {
      mockAssertLeaseOwned.mockImplementation(() => {
        throw LEASE_ERROR
      })
      throw LEASE_ERROR
    })

    await expect(processAuthorization()).rejects.toThrow('source-job lease ownership lost')

    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('last_sync_status = $2'))
    ).toBe(false)
  })

  it('suspends after the third failure and emits the account-attention notification', async () => {
    queueQueries({ ...AUTH, consecutive_failures: 2 })
    mockQuery.mockResolvedValue({ rows: [] })
    mockDecrypt.mockImplementation(() => {
      throw new Error('credential unreadable')
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processAuthorization()

    expect(result).toMatchObject({ ok: false, detail: 'credential unreadable' })
    expect(mockQuery).toHaveBeenCalledWith(expect.stringContaining('last_sync_status = $2'), [
      'auth-1',
      'error',
      3,
      'suspended',
      'credential unreadable',
    ])
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO public.notifications'))
    ).toBe(true)
  })
})
