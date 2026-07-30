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

interface MockAuthorization {
  id: string
  authorization_generation: number
  user_id: string
  platform: string
  trader_id: string
  encrypted_api_key: string
  encrypted_api_secret: string
  encrypted_passphrase: string | null
  last_sync_at: string | null
  consecutive_failures: number
}

const AUTH: MockAuthorization = {
  id: 'auth-1',
  authorization_generation: 1,
  user_id: 'user-1',
  platform: 'bybit',
  trader_id: 'trader-1',
  encrypted_api_key: 'key-cipher',
  encrypted_api_secret: 'secret-cipher',
  encrypted_passphrase: null,
  last_sync_at: null,
  consecutive_failures: 0,
}

let mockSnapshots: Array<{ ts: string; equity: number; net_transfer_cum: number | null }> = []

function claimed(auth = AUTH) {
  return {
    status: 'claimed',
    authorization_id: auth.id,
    generation: auth.authorization_generation,
    user_id: auth.user_id,
    platform: auth.platform,
    trader_id: auth.trader_id,
    encrypted_api_key: auth.encrypted_api_key,
    encrypted_api_secret: auth.encrypted_api_secret,
    encrypted_passphrase: auth.encrypted_passphrase,
    last_sync_at: auth.last_sync_at,
    consecutive_failures: auth.consecutive_failures,
  }
}

async function fallbackQuery(statement: string, values?: readonly unknown[]) {
  if (statement.includes('FROM arena.first_party_snapshots')) {
    return { rows: mockSnapshots }
  }
  if (statement.includes('finish_first_party_authorization_sync_atomic')) {
    const generation = Number(values?.[1])
    const priorFailures = Number(values?.[2])
    const succeeded = values?.[3] === true
    const failures = succeeded ? 0 : priorFailures + 1
    const suspended = !succeeded && failures >= 3
    return {
      rows: [
        {
          result: {
            status: 'recorded',
            authorization_status: suspended ? 'suspended' : 'active',
            generation: suspended ? generation + 1 : generation,
            consecutive_failures: failures,
            notification_needed: suspended,
            synced_at: '2026-07-29T00:00:00.000Z',
          },
        },
      ],
    }
  }
  return { rows: [] }
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
  auth: MockAuthorization = AUTH,
  source: { slug: string; exchange_slug: string } = {
    slug: 'bybit_copytrade',
    exchange_slug: 'bybit',
  },
  snapshots: Array<{ ts: string; equity: number; net_transfer_cum: number | null }> = []
) {
  mockSnapshots = snapshots
  mockQuery
    .mockResolvedValueOnce({ rows: [{ result: claimed(auth) }] })
    .mockResolvedValueOnce({ rows: [source] })
    .mockResolvedValueOnce({ rows: [{ id: 99 }] })
}

describe('first-party sync processor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockSnapshots = []
    mockQuery.mockReset().mockImplementation(fallbackQuery)
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
      {
        fullSeries: true,
        firstPartyAuthorization: {
          authorizationId: 'auth-1',
          generation: 1,
        },
      }
    )
    expect(mockFetchAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        balanceSource: 'bybit_total_equity',
        balanceSemantics: 'total_includes_unrealized',
        realizedPnlSource: 'positions_history',
        requireStablePnlCurrency: true,
        positionHistoryMaxRangeDays: 7,
        transferLedgerContract: expect.objectContaining({
          maxRangeDays: 7,
          pageLimit: 50,
          untilParam: 'endTime',
        }),
      })
    )
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('arena.first_party_snapshots'))
    ).toBe(true)
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('finish_first_party_authorization_sync_atomic'),
      ['auth-1', 1, 0, true, 'ok stats=3 rejects=0', 99, 100, 90, 10, 0, 'USDT']
    )
  })

  it('uses the latest durable snapshot as the transfer replay cursor', async () => {
    const staleAuthorizationSync = '2026-07-28T10:00:00.000Z'
    const latestSnapshot = '2026-07-28T11:00:00.000Z'
    queueQueries(
      { ...AUTH, last_sync_at: staleAuthorizationSync },
      { slug: 'bybit_copytrade', exchange_slug: 'bybit' },
      [{ ts: latestSnapshot, equity: 100, net_transfer_cum: 5 }]
    )

    const result = await processAuthorization()

    expect(result.ok).toBe(true)
    expect(mockFetchAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lastSyncMs: Date.parse(latestSnapshot) })
    )
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

      const result = await processAuthorization()

      expect(result.ok).toBe(true)
      expect(mockQuery.mock.calls[1]?.[1]).toEqual([platform, null])
      expect(mockCcxtConfigs).toHaveLength(1)
      expect(mockCcxtConfigs[0]).toMatchObject({ options: { defaultType } })
      expect(mockFetchAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          balanceSource: 'binance_margin_balance',
          balanceSemantics: 'total_includes_unrealized',
          realizedPnlSource: 'income_ledger',
          transferLedgerContract: expect.objectContaining({
            pageLimit: 1000,
            untilParam: 'until',
          }),
        })
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

    const result = await processAuthorization()

    expect(result.ok).toBe(true)
    expect(mockCcxtConfigs).toHaveLength(1)
    expect(mockFetchAccount).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        realizedPnlSource: 'positions_history',
        positionHistoryMaxRangeDays: 90,
      })
    )
  })

  it('fails closed when the pinned adapter has no trusted first-party history contract', async () => {
    queueQueries(
      { ...AUTH, platform: 'htx_futures' },
      { slug: 'htx_futures', exchange_slug: 'htx' }
    )
    mockGetSourceBySlug.mockResolvedValue({
      id: 7,
      slug: 'htx_futures',
      product_type: 'futures',
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processAuthorization()

    expect(result).toMatchObject({
      ok: false,
      detail: 'unsupported first-party exchange htx',
    })
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockFetchAccount).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
  })

  it('does not mark a sync successful when any required stats window fails validation', async () => {
    queueQueries()
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
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('finish_first_party_authorization_sync_atomic'),
      [
        'auth-1',
        1,
        0,
        false,
        'first-party stats validation failed: valid=1 rejects=1',
        null,
        null,
        null,
        null,
        null,
        null,
      ]
    )
  })

  it('fails closed instead of choosing an ambiguous source alias', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ result: claimed(AUTH) }] }).mockResolvedValueOnce({
      rows: [
        { slug: 'bybit_copytrade', exchange_slug: 'bybit' },
        { slug: 'bybit_shadow', exchange_slug: 'bybit' },
      ],
    })

    const result = await processAuthorization()

    expect(result).toMatchObject({ ok: false, detail: 'ambiguous platform bybit' })
    expect(mockGetSourceBySlug).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('finish_first_party_authorization_sync_atomic'),
      ['auth-1', 1, 0, false, 'ambiguous platform bybit', null, null, null, null, null, null]
    )
  })

  it('does not publish or penalize the user after losing authorization lease ownership', async () => {
    queueQueries()
    mockRenewLease.mockImplementation(async () => {
      mockAssertLeaseOwned.mockImplementation(() => {
        throw LEASE_ERROR
      })
      throw LEASE_ERROR
    })

    await expect(processAuthorization()).rejects.toThrow('source-job lease ownership lost')

    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockQuery.mock.calls.some(([sql]) =>
        String(sql).includes('finish_first_party_authorization_sync_atomic')
      )
    ).toBe(false)
  })

  it('suspends after the third failure and emits the account-attention notification', async () => {
    queueQueries({ ...AUTH, consecutive_failures: 2 })
    mockDecrypt.mockImplementation(() => {
      throw new Error('credential unreadable')
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processAuthorization()

    expect(result).toMatchObject({ ok: false, detail: 'credential unreadable' })
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('finish_first_party_authorization_sync_atomic'),
      ['auth-1', 1, 2, false, 'credential unreadable', null, null, null, null, null, null]
    )
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO public.notifications'))
    ).toBe(true)
  })

  it('never decrypts credentials when active-account claim admission is suspended', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ result: { status: 'suspended' } }] })

    const result = await processAuthorization()

    expect(result).toEqual({
      ok: false,
      statsWritten: 0,
      seriesPoints: 0,
      detail: 'status=suspended',
    })
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockFetchAccount).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
  })
})
