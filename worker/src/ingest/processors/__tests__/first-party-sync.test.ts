const mockQuery = jest.fn()
const mockPublishProfile = jest.fn()
const mockFetchAccount = jest.fn()
const mockCompute = jest.fn()
const mockDecrypt = jest.fn((value: string) => `plain:${value}`)
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
  validateStats: (stats: unknown) => ({ valid: stats, rejects: [] }),
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
    mockGetSourceBySlug.mockReset().mockResolvedValue({
      id: 7,
      slug: 'bybit_copytrade',
      product_type: 'futures',
    })
    mockDecrypt.mockImplementation((value: string) => `plain:${value}`)
    mockPublishProfile.mockResolvedValue(undefined)
    mockFetchAccount.mockResolvedValue({ equity: 100 })
    mockCompute.mockReturnValue({
      stats: [{ timeframe: 90, roi: 12 }],
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

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

    expect(result).toMatchObject({ ok: true, statsWritten: 1, seriesPoints: 1 })
    expect(mockPublishProfile).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'bybit_copytrade' }),
      99,
      expect.objectContaining({ stats: [{ timeframe: 90, roi: 12 }] }),
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
      'ok stats=1 rejects=0',
    ])
  })

  it.each([
    ['binance_futures', 'futures', 'swap'],
    ['binance_spot', 'spot', 'spot'],
  ])(
    'constructs %s from the registry exchange identity with the matching CCXT product type',
    async (platform, productType, defaultType) => {
      queueQueries({ ...AUTH, platform }, { slug: platform, exchange_slug: 'binance' })
      mockGetSourceBySlug.mockResolvedValue({
        id: 7,
        slug: platform,
        product_type: productType,
      })
      mockQuery.mockResolvedValue({ rows: [] })

      const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

      expect(result.ok).toBe(true)
      expect(mockQuery.mock.calls[1]?.[1]).toEqual([platform, null])
      expect(mockCcxtConfigs).toHaveLength(1)
      expect(mockCcxtConfigs[0]).toMatchObject({ options: { defaultType } })
    }
  )

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

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

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

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

    expect(result.ok).toBe(true)
    expect(mockCcxtConfigs).toHaveLength(1)
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

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

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

  it('suspends after the third failure and emits the account-attention notification', async () => {
    queueQueries({ ...AUTH, consecutive_failures: 2 })
    mockQuery.mockResolvedValue({ rows: [] })
    mockDecrypt.mockImplementation(() => {
      throw new Error('credential unreadable')
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

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
