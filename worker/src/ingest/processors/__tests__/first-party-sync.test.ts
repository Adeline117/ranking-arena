const mockQuery = jest.fn()
const mockPublishProfile = jest.fn()
const mockFetchAccount = jest.fn()
const mockCompute = jest.fn()
const mockDecrypt = jest.fn((value: string) => `plain:${value}`)

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: () => ({ query: mockQuery }),
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
jest.mock('@/lib/portfolio/exchange-sync', () => ({
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
}

function queueQueries(auth = AUTH) {
  mockQuery
    .mockResolvedValueOnce({ rows: [auth] })
    .mockResolvedValueOnce({ rows: [{ slug: 'bybit' }] })
    .mockResolvedValueOnce({ rows: [{ id: 99 }] })
    .mockResolvedValueOnce({ rows: [] })
}

describe('first-party sync processor', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
      expect.objectContaining({ slug: 'bybit' }),
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
