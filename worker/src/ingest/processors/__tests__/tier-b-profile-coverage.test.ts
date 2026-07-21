import type { Job } from 'bullmq'
import type { ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockProfileTimeframes = jest.fn()
const mockGetLatestPassedNativeCohort = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockGetHistory = jest.fn()
const mockParseProfile = jest.fn()
const mockValidateProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockValidateStats = jest.fn()
const mockRoiCrossCheckOk = jest.fn()
const mockGetHistoryCursor = jest.fn()
const mockPublishProfile = jest.fn()
const mockDbQuery = jest.fn()
const mockQueueAdd = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
  profileTimeframes: (...args: unknown[]) => mockProfileTimeframes(...args),
}))
jest.mock('@/lib/ingest/native-cohort', () => ({
  getLatestPassedNativeCohort: (...args: unknown[]) => mockGetLatestPassedNativeCohort(...args),
}))
jest.mock('@/lib/ingest/core/adapter', () => ({
  getAdapter: (...args: unknown[]) => mockGetAdapter(...args),
}))
jest.mock('@/lib/ingest/core/history-cursor', () => ({ nextHistoryCursor: jest.fn() }))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  roiCrossCheckOk: (...args: unknown[]) => mockRoiCrossCheckOk(...args),
  validateStats: (...args: unknown[]) => mockValidateStats(...args),
}))
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  getHistoryCursor: (...args: unknown[]) => mockGetHistoryCursor(...args),
  publishHistoryRows: jest.fn(),
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: jest.fn(async () => undefined),
}))
jest.mock('../../queues', () => ({
  getRegionQueue: jest.fn(() => ({ add: (...args: unknown[]) => mockQueueAdd(...args) })),
  INGEST_JOB: { TIER_B: 'tier-b' },
}))

import { processTierB } from '../tier-b-profiles'

const src = {
  id: 34,
  slug: 'gtrade',
  adapter_slug: 'gtrade',
  status: 'active',
  currency: 'USDC',
  tf_label_map: {},
  meta: {},
  timeframes_native: [7, 30],
  timeframes_derived: [],
  deep_profile_topn: 300,
  cadence_tier_b_seconds: 21_600,
  fetch_region: 'local',
} as SourceRow & { cadence_tier_b_seconds: number }

function profile(timeframe: 7 | 30, complete: boolean): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe,
        asOf: '2026-07-15T12:00:00.000Z',
        roi: null,
        pnl: complete ? 1 : null,
        sharpe: null,
        mdd: null,
        winRate: null,
        winPositions: complete ? 0 : null,
        totalPositions: complete ? 0 : null,
        copierPnl: null,
        copierCount: null,
        aum: null,
        volume: null,
        profitShareRate: null,
        holdingDurationAvgHours: null,
        tradingPreferences: null,
        extras: {
          profile_window_metrics_complete: complete,
          profile_window_metrics_incomplete_reason: complete ? null : 'window_prefix_not_covered',
        },
      },
    ],
    series: [],
  }
}

const job = { data: { sourceSlug: 'gtrade' } } as Job<TierJobData>

describe('Tier-B profile coverage accounting', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockProfileTimeframes.mockReturnValue([7, 30])
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: false,
        orders: false,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      validateProfile: mockValidateProfile,
    })
    mockGetProfile.mockImplementation(async (_session, _src, _trader, timeframe) => ({
      pages: [
        {
          pageIndex: 1,
          payload: { timeframe },
          url: 'https://gtrade.test/profile',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    }))
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockSessionClose.mockResolvedValue(undefined)
    mockWriteRawObject.mockResolvedValue({
      id: 2_081_896,
      storagePath: 'test/tier_b/raw.json.gz',
      contentHash: 'a'.repeat(64),
    })
    mockRecordStagingRejects.mockResolvedValue(undefined)
    mockValidateProfile.mockReturnValue([])
    mockValidateStats.mockImplementation((stats: unknown[]) => ({ valid: stats, rejects: [] }))
    mockRoiCrossCheckOk.mockReturnValue(null)
    mockPublishProfile.mockResolvedValue(undefined)
    mockQueueAdd.mockResolvedValue(undefined)
    mockGetLatestPassedNativeCohort.mockResolvedValue({
      traders: [
        {
          id: 42,
          exchange_trader_id: '0x0000000000000000000000000000000000000001',
          meta: null,
          headline_rois: {},
        },
      ],
      nativeTimeframes: [7, 30],
      foundTimeframes: [7, 30],
      missingTimeframes: [],
    })
    mockDbQuery.mockResolvedValue({ rows: [], rowCount: 1 })
  })

  it('does not mark a trader fresh when one timeframe is unproven', async () => {
    mockParseProfile.mockImplementation((raw: { timeframe: 7 | 30 }) =>
      profile(raw.timeframe, raw.timeframe === 7)
    )

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      errors: 1,
      remaining: 0,
    })

    expect(mockWriteRawObject).toHaveBeenCalledTimes(2)
    expect(mockPublishProfile).toHaveBeenCalledTimes(2)
    expect(mockGetLatestPassedNativeCohort).toHaveBeenCalledWith(src, {
      excludeClaimed: true,
      profileCursor: {
        kind: 'tierb_profiled',
        stalerThan: expect.any(Date),
      },
    })
    expect(mockProfileTimeframes).toHaveBeenCalledWith(src)
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('marks the trader only after every requested timeframe succeeds', async () => {
    mockParseProfile.mockImplementation((raw: { timeframe: 7 | 30 }) =>
      profile(raw.timeframe, true)
    )

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      surfacesFetched: 2,
      errors: 0,
    })
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })

  it('skips product-specific histories declared unsupported by a shared adapter', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positions: true,
        positionHistory: true,
        orders: false,
        transfers: false,
        copiers: true,
      },
      supportsSurface: (_source: SourceRow, surface: string) =>
        surface !== 'positionHistory' && surface !== 'copiers',
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      validateProfile: mockValidateProfile,
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      surfacesFetched: 1,
      historyRowsWritten: 0,
      errors: 0,
    })
    expect(mockGetHistory).not.toHaveBeenCalled()
  })

  it('audits a bundle-wide quality reject before any validation or publication', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockGetProfile.mockResolvedValue({
      pages: [
        {
          pageIndex: 1,
          payload: { part: 1 },
          url: 'https://gtrade.test/profile/1',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
        {
          pageIndex: 2,
          payload: { part: 2 },
          url: 'https://gtrade.test/profile/2',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    })
    mockParseProfile.mockReturnValue(profile(30, true))
    mockValidateProfile.mockImplementation(
      (_parsed: ParsedProfile, _ctx: unknown, _timeframe: number, raw: { part: number }) =>
        raw.part === 2
          ? [
              {
                reason: 'profile_series_tail_stale',
                payload: { blocking_reasons: ['profile_series_tail_stale'] },
              },
            ]
          : []
    )
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: false,
        orders: true,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      validateProfile: mockValidateProfile,
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      rejects: 1,
      errors: 0,
      crossCheckFails: 0,
    })

    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockParseProfile).toHaveBeenCalledTimes(2)
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
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(
      34,
      2_081_896,
      expect.arrayContaining([
        expect.objectContaining({
          reason: 'profile_series_tail_stale',
          payload: expect.objectContaining({ trader_id: 42, timeframe: 30, page_index: 2 }),
        }),
      ])
    )
    expect(mockValidateStats).not.toHaveBeenCalled()
    expect(mockRoiCrossCheckOk).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetHistory).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })

  it('records an empty bundle as an explicit terminal payload reject', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockGetProfile.mockResolvedValue({
      pages: [],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      rejects: 1,
      errors: 0,
    })
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(34, 2_081_896, [
      expect.objectContaining({
        reason: 'profile_payload_missing',
        payload: expect.objectContaining({ trader_id: 42, timeframe: 30, page_count: 0 }),
      }),
    ])
    expect(mockParseProfile).not.toHaveBeenCalled()
    expect(mockValidateProfile).not.toHaveBeenCalled()
    expect(mockValidateStats).not.toHaveBeenCalled()
    expect(mockRoiCrossCheckOk).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })

  it('marks a mixed success/quality terminal attempt without crawling histories', async () => {
    mockParseProfile.mockImplementation((raw: { timeframe: 7 | 30 }) =>
      profile(raw.timeframe, true)
    )
    mockValidateProfile.mockImplementation(
      (_parsed: ParsedProfile, _ctx: unknown, timeframe: number) =>
        timeframe === 7
          ? [{ reason: 'profile_series_tail_stale', payload: { tail_at: '2025-01-01' } }]
          : []
    )
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: false,
        orders: true,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      validateProfile: mockValidateProfile,
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 2,
      rejects: 1,
      errors: 0,
      historyRowsWritten: 0,
    })
    expect(mockRecordStagingRejects).toHaveBeenCalledTimes(1)
    expect(mockValidateStats).toHaveBeenCalledTimes(1)
    expect(mockPublishProfile).toHaveBeenCalledTimes(1)
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetHistory).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })

  it('does not advance the attempt cursor when any timeframe has an operational error', async () => {
    mockGetProfile.mockImplementation(async (_session, _source, _trader, timeframe) => {
      if (timeframe === 30) throw new Error('upstream unavailable')
      return {
        pages: [
          {
            pageIndex: 1,
            payload: { timeframe },
            url: 'https://gtrade.test/profile',
            fetchedAt: '2026-07-15T12:00:00.000Z',
          },
        ],
        fetchedAt: '2026-07-15T12:00:00.000Z',
      }
    })
    mockParseProfile.mockImplementation((raw: { timeframe: 7 | 30 }) =>
      profile(raw.timeframe, true)
    )
    mockValidateProfile.mockImplementation(
      (_parsed: ParsedProfile, _ctx: unknown, timeframe: number) =>
        timeframe === 7
          ? [{ reason: 'profile_series_tail_stale', payload: { tail_at: '2025-01-01' } }]
          : []
    )

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      rejects: 1,
      errors: 1,
      historyRowsWritten: 0,
    })
    expect(mockRecordStagingRejects).toHaveBeenCalledTimes(1)
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(false)
  })

  it('treats a reject-audit write failure as operational and retryable', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockValidateProfile.mockReturnValue([
      { reason: 'profile_series_tail_stale', payload: { tail_at: '2025-01-01' } },
    ])
    mockRecordStagingRejects.mockRejectedValue(new Error('staging audit unavailable'))

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 0,
      rejects: 0,
      errors: 1,
      historyRowsWritten: 0,
    })
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(false)
  })

  it('enqueues a distinct next-hop continuation while the current hop is active', async () => {
    mockGetSourceBySlug.mockResolvedValue({
      ...src,
      meta: { tier_b_deadline_ms: 60_000 },
    })
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetLatestPassedNativeCohort.mockResolvedValue({
      traders: [
        {
          id: 42,
          exchange_trader_id: '0x0000000000000000000000000000000000000001',
          meta: null,
          headline_rois: {},
        },
        {
          id: 43,
          exchange_trader_id: '0x0000000000000000000000000000000000000002',
          meta: null,
          headline_rois: {},
        },
      ],
      nativeTimeframes: [7, 30],
      foundTimeframes: [7, 30],
      missingTimeframes: [],
    })
    const now = jest
      .spyOn(Date, 'now')
      .mockReturnValueOnce(1_784_700_000_000)
      .mockReturnValueOnce(1_784_700_000_000)
      .mockReturnValueOnce(1_784_700_061_000)
    const continuation = {
      id: 'tierb-cont-gtrade-1',
      data: { sourceSlug: 'gtrade', contDepth: 1 },
    } as Job<TierJobData>

    let result
    try {
      result = await processTierB(continuation)
    } finally {
      now.mockRestore()
    }
    expect(result).toMatchObject({
      tradersCrawled: 1,
      remaining: 1,
    })
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'tier-b',
      { sourceSlug: 'gtrade', contDepth: 2 },
      expect.objectContaining({
        priority: 6,
        jobId: 'tierb-cont-gtrade-2',
      })
    )
  })
})
