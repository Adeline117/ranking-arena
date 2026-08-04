const mockQuery = jest.fn()
const mockGuardQuery = jest.fn()
const mockGuardRelease = jest.fn()
const mockPublishProfile = jest.fn()
const mockFetchAccount = jest.fn()
const mockCompute = jest.fn()
const mockDecrypt = jest.fn((value: string) => `plain:${value}`)

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: mockQuery }),
  ingestClientConnect: async () => ({ query: mockGuardQuery, release: mockGuardRelease }),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: jest.fn().mockResolvedValue({ id: 7, slug: 'bybit' }),
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
jest.mock('@/lib/exchange/ccxt-read-transport', () => ({
  CCXT_ID: { bybit: 'bybit' },
  GEO_BLOCKED: new Set(),
  PASSPHRASE_REQUIRED: new Set(),
  makeProxyFetch: () => null,
}))
jest.mock('@/lib/exchange/authorization-credentials', () => ({
  decryptAuthorizationCredential: (value: string) => mockDecrypt(value),
}))
jest.mock('ccxt', () => {
  class MockBybit {}
  return { __esModule: true, default: { bybit: MockBybit }, bybit: MockBybit }
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
  updated_at: '2026-08-03T12:00:00.000Z',
}

let currentAuth = AUTH
let approvedMappings: Array<{ slug: string; trader_id: number }> = [
  { slug: 'bybit', trader_id: 99 },
]
let markRows: Array<{ consecutive_failures: number; status: string }> = [
  { consecutive_failures: 0, status: 'active' },
]
let currentGeneration = true

describe('first-party sync processor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    currentAuth = AUTH
    approvedMappings = [{ slug: 'bybit', trader_id: 99 }]
    markRows = [{ consecutive_failures: 0, status: 'active' }]
    currentGeneration = true
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
    mockQuery.mockImplementation(async (sql: unknown) => {
      const statement = String(sql)
      if (statement.includes('FROM public.trader_authorizations WHERE id = $1')) {
        return { rows: [currentAuth] }
      }
      if (statement.includes('FROM public.verified_traders AS verified')) {
        return { rows: approvedMappings }
      }
      if (statement.includes('FROM arena.first_party_snapshots')) {
        return { rows: [] }
      }
      if (statement.includes('UPDATE public.trader_authorizations')) {
        return { rows: markRows }
      }
      return { rows: [] }
    })
    mockGuardQuery.mockImplementation(async (sql: unknown) => {
      const statement = String(sql)
      if (statement.includes('FROM public.user_exchange_connections')) {
        return { rows: [{ id: 'connection-1' }] }
      }
      if (statement.includes('FROM public.trader_authorizations')) {
        return { rows: currentGeneration ? [{ id: currentAuth.id }] : [] }
      }
      if (statement.includes('UPDATE public.trader_authorizations')) {
        return { rows: markRows }
      }
      return { rows: [] }
    })
  })

  it('publishes an explicitly reviewed variant through the canonical account lock', async () => {
    currentAuth = { ...AUTH, platform: 'bybit_spot' }

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

    expect(result).toMatchObject({ ok: true, statsWritten: 1, seriesPoints: 1 })
    expect(mockPublishProfile).toHaveBeenCalledWith(
      expect.objectContaining({ slug: 'bybit' }),
      99,
      expect.objectContaining({ stats: [{ timeframe: 90, roi: 12 }] }),
      { fullSeries: true }
    )
    expect(
      mockGuardQuery.mock.calls.some(([sql]) => String(sql).includes('arena.first_party_snapshots'))
    ).toBe(true)
    expect(mockGuardQuery).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), [
      'trader-account:user-1:bybit',
    ])
    expect(mockGuardQuery).toHaveBeenCalledWith(expect.stringContaining('encrypted_api_key = $5'), [
      'auth-1',
      'user-1',
      'bybit_spot',
      'trader-1',
      'key-cipher',
      'secret-cipher',
      null,
      '2026-08-03T12:00:00.000Z',
    ])
    expect(mockGuardQuery).toHaveBeenCalledWith(expect.stringContaining("AND status = 'active'"), [
      'auth-1',
      'success',
      'ok stats=1 rejects=0',
      'user-1',
      'bybit_spot',
      'trader-1',
      'key-cipher',
      'secret-cipher',
      null,
      '2026-08-03T12:00:00.000Z',
    ])
    const connectionLockIndex = mockGuardQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes('FROM public.user_exchange_connections')
    )
    const markUpdateIndex = mockGuardQuery.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE public.trader_authorizations')
    )
    expect(connectionLockIndex).toBeGreaterThan(-1)
    expect(markUpdateIndex).toBeGreaterThan(connectionLockIndex)
    expect(String(mockGuardQuery.mock.calls[markUpdateIndex]?.[0])).not.toContain(
      'last_verified_at'
    )
    expect(mockGuardRelease).toHaveBeenCalledTimes(2)
  })

  it('suspends after the third failure and emits the account-attention notification', async () => {
    currentAuth = { ...AUTH, consecutive_failures: 2 }
    markRows = [{ consecutive_failures: 3, status: 'suspended' }]
    mockDecrypt.mockImplementation(() => {
      throw new Error('credential unreadable')
    })
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

    expect(result).toMatchObject({ ok: false, detail: 'credential unreadable' })
    expect(mockGuardQuery).toHaveBeenCalledWith(
      expect.stringContaining('consecutive_failures + 1'),
      [
        'auth-1',
        'error',
        'credential unreadable',
        'user-1',
        'bybit',
        'trader-1',
        'key-cipher',
        'secret-cipher',
        null,
        '2026-08-03T12:00:00.000Z',
      ]
    )
    expect(
      mockQuery.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO public.notifications'))
    ).toBe(true)
    expect(mockGuardRelease).toHaveBeenCalledTimes(1)
  })

  it('does not decrypt, fetch, or publish an account without reviewed public identity mapping', async () => {
    approvedMappings = []

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

    expect(result).toEqual({
      ok: false,
      statsWritten: 0,
      seriesPoints: 0,
      detail: 'public first-party publishing is not approved for this account',
    })
    expect(mockDecrypt).not.toHaveBeenCalled()
    expect(mockFetchAccount).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(mockGuardQuery).not.toHaveBeenCalled()
  })

  it('drops fetched data when the authorization was revoked or rotated in flight', async () => {
    currentGeneration = false

    const result = await processFirstPartySync({ data: { authorizationId: 'auth-1' } } as never)

    expect(result).toEqual({
      ok: false,
      statsWritten: 0,
      seriesPoints: 0,
      detail: 'authorization revoked or rotated during sync',
    })
    expect(mockFetchAccount).toHaveBeenCalledTimes(1)
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockGuardQuery.mock.calls.some(([sql]) => String(sql).includes('arena.first_party_snapshots'))
    ).toBe(false)
    expect(
      mockGuardQuery.mock.calls.some(([sql]) =>
        String(sql).includes('UPDATE public.trader_authorizations')
      )
    ).toBe(false)
    expect(mockGuardQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(mockGuardRelease).toHaveBeenCalledTimes(1)
  })
})
