import type { Job } from 'bullmq'
import type { ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockProfileTimeframes = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockParseProfile = jest.fn()
const mockValidateProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockValidateStats = jest.fn()
const mockPublishProfile = jest.fn()
const mockDbQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
  profileTimeframes: (...args: unknown[]) => mockProfileTimeframes(...args),
}))
jest.mock('@/lib/ingest/core/adapter', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  validateStats: (...args: unknown[]) => mockValidateStats(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
jest.mock('@/lib/logger', () => ({ logger: { info: jest.fn() } }))

import { processTierBSeries } from '../tier-b-series'

const src = {
  id: 34,
  slug: 'kucoin_futures',
  adapter_slug: 'kucoin',
  status: 'active',
  currency: 'USDT',
  tf_label_map: {},
  deep_profile_topn: 300,
  meta: {
    series_backfill_topn: 302,
    series_backfill_batch: 1,
    series_backfill_newcomers: 1,
  },
} as SourceRow

const job = { data: { sourceSlug: src.slug } } as Job<TierJobData>

function profile(): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe: 30,
        asOf: '2026-07-16T16:00:00.000Z',
        roi: 10,
        pnl: 100,
        sharpe: null,
        mdd: null,
        winRate: null,
        winPositions: null,
        totalPositions: null,
        copierPnl: null,
        copierCount: null,
        aum: null,
        volume: null,
        profitShareRate: null,
        holdingDurationAvgHours: null,
        tradingPreferences: null,
        extras: {},
      },
    ],
    replaceSeries: [{ timeframe: 30, metrics: ['pnl'] }],
    series: [
      {
        timeframe: 30,
        metric: 'pnl',
        points: [{ ts: '2026-07-16T00:00:00.000Z', value: 100 }],
      },
    ],
  }
}

function useSingleCursorTrader(): void {
  mockGetSourceBySlug.mockResolvedValue({
    ...src,
    meta: { ...src.meta, series_backfill_newcomers: 0 },
  })
  mockDbQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT count(*)::int AS n')) {
      return { rows: [{ n: 2 }], rowCount: 1 }
    }
    if (sql.includes('OFFSET $4 LIMIT $5')) {
      return {
        rows: [{ id: 42, exchange_trader_id: '1000569', meta: null, rank: 301 }],
        rowCount: 1,
      }
    }
    return { rows: [], rowCount: 0 }
  })
}

describe('Tier-B series quality scheduling', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockProfileTimeframes.mockReturnValue([30])
    mockGetAdapter.mockReturnValue({
      capabilities: { profile: true },
      getProfile: mockGetProfile,
      parseProfile: mockParseProfile,
      validateProfile: mockValidateProfile,
    })
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue({
      id: 2_081_896,
      storagePath: 'test/tier_b_series/raw.json.gz',
      contentHash: 'a'.repeat(64),
    })
    mockRecordStagingRejects.mockResolvedValue(undefined)
    mockParseProfile.mockReturnValue(profile())
    mockValidateProfile.mockReturnValue([])
    mockValidateStats.mockImplementation((stats: unknown[]) => ({ valid: stats, rejects: [] }))
    mockPublishProfile.mockResolvedValue(undefined)
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT count(*)::int AS n')) {
        return { rows: [{ n: 1 }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
  })

  it('cools never-published newcomer attempts for 24 hours', async () => {
    await expect(processTierBSeries(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      bandSize: 1,
      errors: 0,
    })

    const newcomerSql = mockDbQuery.mock.calls
      .map(([sql]) => String(sql))
      .find((sql) => sql.includes('NOT EXISTS (SELECT 1 FROM arena.trader_series'))
    expect(newcomerSql).toContain('FROM arena.raw_objects ro')
    expect(newcomerSql).toContain('ro.source_id = $1')
    expect(newcomerSql).toContain("ro.job_type = 'tier_b_series'")
    expect(newcomerSql).toContain('ro.trader_id = t.id')
    expect(newcomerSql).toContain("ro.fetched_at > now() - interval '24 hours'")
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('quarantines a whole multi-page surface when a later page is unsafe', async () => {
    useSingleCursorTrader()
    mockGetProfile.mockResolvedValue({
      pages: [
        {
          pageIndex: 1,
          payload: { part: 1 },
          url: 'https://kucoin.test/profile/1',
          fetchedAt: '2026-07-16T16:00:00.000Z',
        },
        {
          pageIndex: 2,
          payload: { part: 2 },
          url: 'https://kucoin.test/profile/2',
          fetchedAt: '2026-07-16T16:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-16T16:00:00.000Z',
    })
    mockValidateProfile.mockImplementation(
      (_parsed: ParsedProfile, _ctx: unknown, _timeframe: number, raw: { part: number }) =>
        raw.part === 2
          ? [{ reason: 'profile_series_tail_stale', payload: { tail_at: '2025-05-21' } }]
          : []
    )

    await expect(processTierBSeries(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      seriesWritten: 0,
      rejects: 1,
      errors: 0,
      cursorFrom: 0,
      cursorTo: 1,
      bandSize: 2,
    })

    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockParseProfile).toHaveBeenCalledTimes(2)
    expect(mockParseProfile.mock.results[0].value).toMatchObject({
      replaceSeries: [{ timeframe: 30, metrics: ['pnl'] }],
    })
    expect(mockValidateProfile).toHaveBeenCalledTimes(2)
    expect(mockWriteRawObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseProfile.mock.invocationCallOrder[0]
    )
    expect(mockParseProfile.mock.invocationCallOrder[1]).toBeLessThan(
      mockValidateProfile.mock.invocationCallOrder[0]
    )
    expect(mockValidateProfile.mock.invocationCallOrder[1]).toBeLessThan(
      mockRecordStagingRejects.mock.invocationCallOrder[0]
    )
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(34, 2_081_896, [
      expect.objectContaining({
        reason: 'profile_series_tail_stale',
        payload: expect.objectContaining({ trader_id: 42, timeframe: 30, page_index: 2 }),
      }),
    ])
    expect(mockValidateStats).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(
        ([sql, params]) =>
          String(sql).includes('INSERT INTO arena.ingest_cursors') &&
          JSON.stringify(params) === JSON.stringify([-34, 'series_backfill', '1'])
      )
    ).toBe(true)
  })

  it('keeps the proven surface publication path intact', async () => {
    useSingleCursorTrader()
    const parsed = profile()
    const rawPayload = { part: 1 }
    mockGetProfile.mockResolvedValue({
      pages: [
        {
          pageIndex: 1,
          payload: rawPayload,
          url: 'https://kucoin.test/profile',
          fetchedAt: '2026-07-16T16:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-16T16:00:00.000Z',
    })
    mockParseProfile.mockReturnValue(parsed)

    await expect(processTierBSeries(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      surfacesFetched: 1,
      seriesWritten: 1,
      rejects: 0,
      errors: 0,
      cursorTo: 1,
    })
    expect(mockValidateProfile).toHaveBeenCalledWith(
      parsed,
      expect.objectContaining({ sourceSlug: src.slug }),
      30,
      rawPayload
    )
    expect(mockValidateStats).toHaveBeenCalledTimes(1)
    expect(mockPublishProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: src.id, slug: src.slug }),
      42,
      parsed,
      { fullSeries: true }
    )
    expect(mockValidateProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mockValidateStats.mock.invocationCallOrder[0]
    )
    expect(mockValidateStats.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishProfile.mock.invocationCallOrder[0]
    )
  })

  it('fails an empty bundle closed while preserving cursor progress', async () => {
    useSingleCursorTrader()
    mockGetProfile.mockResolvedValue({
      pages: [],
      fetchedAt: '2026-07-16T16:00:00.000Z',
    })

    await expect(processTierBSeries(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      seriesWritten: 0,
      rejects: 1,
      errors: 0,
      cursorTo: 1,
    })
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockParseProfile).not.toHaveBeenCalled()
    expect(mockValidateProfile).not.toHaveBeenCalled()
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(34, 2_081_896, [
      expect.objectContaining({
        reason: 'profile_payload_missing',
        payload: expect.objectContaining({ trader_id: 42, timeframe: 30, page_count: 0 }),
      }),
    ])
    expect(mockValidateStats).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
  })

  it('treats staging-audit failure as an operational error', async () => {
    useSingleCursorTrader()
    mockGetProfile.mockResolvedValue({
      pages: [
        {
          pageIndex: 1,
          payload: { part: 1 },
          url: 'https://kucoin.test/profile',
          fetchedAt: '2026-07-16T16:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-16T16:00:00.000Z',
    })
    mockValidateProfile.mockReturnValue([
      { reason: 'profile_series_tail_stale', payload: { tail_at: '2025-05-21' } },
    ])
    mockRecordStagingRejects.mockRejectedValue(new Error('staging unavailable'))

    await expect(processTierBSeries(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 0,
      seriesWritten: 0,
      rejects: 0,
      errors: 1,
      cursorTo: 1,
    })
    expect(mockPublishProfile).not.toHaveBeenCalled()
  })
})
