import type { Job } from 'bullmq'
import type { ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import type { TierCJobData } from '../../queues'

const mockRedisSet = jest.fn()
const mockGetSourceBySlug = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockGetPositions = jest.fn()
const mockParseProfile = jest.fn()
const mockValidateProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockResolveTraderId = jest.fn()
const mockPublishProfile = jest.fn()
const mockDbQuery = jest.fn()

jest.mock('../../../connection', () => ({
  getConnection: jest.fn(() => ({ set: (...args: unknown[]) => mockRedisSet(...args) })),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
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
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  getHistoryCursor: jest.fn(),
  publishHistoryRows: jest.fn(),
  publishPositions: jest.fn(),
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
  resolveTraderId: (...args: unknown[]) => mockResolveTraderId(...args),
}))
jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
}))
jest.mock('../../queues', () => ({ tierCResultKey: jest.fn(() => 'tier-c:result') }))

import { processTierC } from '../tier-c-profile'

const src = {
  id: 34,
  slug: 'gtrade',
  adapter_slug: 'gtrade',
  currency: 'USDC',
  tf_label_map: {},
  meta: {},
  fetch_region: 'local',
  profile_cache_ttl_seconds: 3_600,
} as SourceRow & { profile_cache_ttl_seconds: number }

const bundle = {
  pages: [
    {
      pageIndex: 1,
      payload: { raw: true },
      url: 'https://gtrade.test/profile',
      fetchedAt: '2026-07-15T12:00:00.000Z',
    },
  ],
  fetchedAt: '2026-07-15T12:00:00.000Z',
}

function parsedProfile(complete: boolean): ParsedProfile {
  return {
    nickname: null,
    avatarUrlOrigin: null,
    stats: [
      {
        timeframe: 30,
        asOf: '2026-07-15T12:00:00.000Z',
        roi: null,
        pnl: complete ? 10 : null,
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
          ...(complete ? {} : { gtrade_trades_incomplete_reason: 'window_prefix_not_covered' }),
        },
      },
    ],
    series: [],
  }
}

const job = {
  data: {
    sourceSlug: 'gtrade',
    exchangeTraderId: '0x0000000000000000000000000000000000000001',
    timeframe: 30,
    surface: 'profile',
  },
} as Job<TierCJobData>

describe('Tier-C incomplete profile window gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockGetAdapter.mockReturnValue({
      getProfile: mockGetProfile,
      parseProfile: mockParseProfile,
      validateProfile: mockValidateProfile,
    })
    mockGetProfile.mockResolvedValue(bundle)
    mockOpenSession.mockResolvedValue({ close: mockSessionClose })
    mockDbQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT t.id, t.meta')) {
        return { rows: [{ id: 42, meta: null }], rowCount: 1 }
      }
      return { rows: [], rowCount: 0 }
    })
    mockResolveTraderId.mockResolvedValue(42)
    mockWriteRawObject.mockResolvedValue({
      id: 2_081_896,
      storagePath: 'test/tier_c/raw.json.gz',
      contentHash: 'a'.repeat(64),
    })
    mockRecordStagingRejects.mockResolvedValue(undefined)
    mockValidateProfile.mockReturnValue([])
    mockRedisSet.mockResolvedValue('OK')
    mockPublishProfile.mockResolvedValue(undefined)
    mockSessionClose.mockResolvedValue(undefined)
  })

  it('persists RAW evidence but never writes render or profile caches', async () => {
    mockParseProfile.mockReturnValue(parsedProfile(false))

    await expect(processTierC(job, 'local')).rejects.toMatchObject({
      name: 'IncompleteProfileWindowError',
      timeframe: 30,
      reason: 'window_prefix_not_covered',
    })

    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'tier_c', traderId: 42, payload: bundle.pages })
    )
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockWriteRawObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseProfile.mock.invocationCallOrder[0]
    )
    expect(mockPublishProfile).toHaveBeenCalledWith(src, 42, parsedProfile(false), {
      fullSeries: false,
    })
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('uses the frozen profile as-of for a complete render payload', async () => {
    mockParseProfile.mockReturnValue(parsedProfile(true))

    await expect(processTierC(job, 'local')).resolves.toMatchObject({
      traderId: 42,
      stats: 1,
      series: 0,
    })

    expect(mockRedisSet).toHaveBeenCalledTimes(1)
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload.asOf).toBe('2026-07-15T12:00:00.000Z')
    expect(renderPayload.qualityRejected).toBeUndefined()
    expect(mockWriteRawObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseProfile.mock.invocationCallOrder[0]
    )
    expect(mockParseProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mockValidateProfile.mock.invocationCallOrder[0]
    )
    expect(mockValidateProfile).toHaveBeenCalledWith(
      parsedProfile(true),
      expect.objectContaining({ sourceSlug: src.slug }),
      30,
      bundle.pages[0].payload
    )
    expect(mockValidateProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedisSet.mock.invocationCallOrder[0]
    )
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(true)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('keeps the full parsed series in render and profile caches', async () => {
    const parsed = parsedProfile(true)
    parsed.series = [
      {
        timeframe: 30,
        metric: 'pnl',
        points: [
          { ts: '2026-07-13T00:00:00.000Z', value: 2 },
          { ts: '2026-07-14T00:00:00.000Z', value: 6 },
          { ts: '2026-07-15T00:00:00.000Z', value: 10 },
        ],
      },
    ]
    mockParseProfile.mockReturnValue(parsed)

    await expect(processTierC(job, 'local')).resolves.toMatchObject({
      traderId: 42,
      stats: 1,
      series: 1,
    })

    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload.series).toEqual(parsed.series)

    const cacheCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.profile_cache')
    )
    expect(cacheCall).toBeDefined()
    const cachePayload = JSON.parse(String((cacheCall?.[1] as unknown[])[4]))
    expect(cachePayload.series).toEqual(parsed.series)
    expect(mockPublishProfile).toHaveBeenCalledWith(src, 42, parsed, { fullSeries: false })
  })

  it('audits a quality reject and completes polling without publishing it', async () => {
    const parsed = parsedProfile(true)
    const reject = {
      reason: 'profile_series_tail_stale',
      payload: {
        requested_timeframe: 30,
        metrics: { pnl: { tail_at: '2026-05-21T00:00:00.000Z' } },
      },
    }
    mockParseProfile.mockReturnValue(parsed)
    mockValidateProfile.mockReturnValue([reject])

    await expect(processTierC(job, 'local')).resolves.toMatchObject({
      traderId: 42,
      qualityRejected: true,
      reason: 'profile_series_tail_stale',
      rejects: 1,
    })

    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(34, 2_081_896, [reject])
    expect(mockRedisSet).toHaveBeenCalledWith('tier-c:result', expect.any(String), 'EX', 120)
    const terminalPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(terminalPayload).toMatchObject({
      completed: true,
      qualityRejected: true,
      reason: 'profile_series_tail_stale',
      timeframe: 30,
      asOf: expect.any(String),
    })
    expect(terminalPayload.stats).toBeUndefined()
    expect(terminalPayload.series).toBeUndefined()
    expect(mockResolveTraderId).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockWriteRawObject.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseProfile.mock.invocationCallOrder[0]
    )
    expect(mockParseProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mockValidateProfile.mock.invocationCallOrder[0]
    )
    expect(mockValidateProfile.mock.invocationCallOrder[0]).toBeLessThan(
      mockRecordStagingRejects.mock.invocationCallOrder[0]
    )
    expect(mockRecordStagingRejects.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedisSet.mock.invocationCallOrder[0]
    )
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('fails an empty profile bundle closed after preserving RAW', async () => {
    mockGetProfile.mockResolvedValue({ ...bundle, pages: [] })

    await expect(processTierC(job, 'local')).resolves.toMatchObject({
      traderId: 42,
      qualityRejected: true,
      reason: 'profile_payload_missing',
      rejects: 1,
    })

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'tier_c', traderId: 42, payload: [] })
    )
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockParseProfile).not.toHaveBeenCalled()
    expect(mockValidateProfile).not.toHaveBeenCalled()
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(34, 2_081_896, [
      expect.objectContaining({
        reason: 'profile_payload_missing',
        payload: expect.objectContaining({ page_count: 0, requested_timeframe: 30 }),
      }),
    ])
    const terminalPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(terminalPayload).toMatchObject({
      completed: true,
      qualityRejected: true,
      reason: 'profile_payload_missing',
      timeframe: 30,
    })
    expect(mockResolveTraderId).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
  })

  it('does not publish a terminal marker when reject auditing fails', async () => {
    mockParseProfile.mockReturnValue(parsedProfile(true))
    mockValidateProfile.mockReturnValue([
      { reason: 'profile_series_tail_stale', payload: { requested_timeframe: 30 } },
    ])
    mockRecordStagingRejects.mockRejectedValue(new Error('staging audit unavailable'))

    await expect(processTierC(job, 'local')).rejects.toThrow('staging audit unavailable')

    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockResolveTraderId).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('rejects a source-specific unsupported heavy surface before opening a session', async () => {
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positions: true,
        positionHistory: true,
        orders: false,
        transfers: false,
        copiers: true,
      },
      supportsSurface: (_source: SourceRow, surface: string) => surface !== 'positions',
      getPositions: mockGetPositions,
    })

    const heavyJob = {
      data: {
        sourceSlug: 'okx_spot',
        exchangeTraderId: 'F503A5D5F1F6989F',
        timeframe: 90,
        surface: 'positions',
      },
    } as Job<TierCJobData>

    await expect(processTierC(heavyJob, 'local')).rejects.toMatchObject({
      name: 'UnsupportedSourceSurfaceError',
      code: 'UNSUPPORTED_SOURCE_SURFACE',
      sourceSlug: 'okx_spot',
      surface: 'positions',
    })
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockGetPositions).not.toHaveBeenCalled()
    expect(mockGetSourceBySlug).toHaveBeenCalledTimes(1)
  })

  it.each(['profile', 'positions'] as const)(
    'rechecks the processor source snapshot before opening a %s session',
    async (surface) => {
      mockGetSourceBySlug.mockResolvedValue({
        ...src,
        fetch_region: 'vps_sg',
      })
      const movedJob = {
        data: {
          ...job.data,
          surface,
        },
      } as Job<TierCJobData>

      await expect(processTierC(movedJob, 'local')).rejects.toThrow(
        'moved from local to vps_sg before fetch'
      )

      expect(mockGetAdapter).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockDbQuery).not.toHaveBeenCalled()
    }
  )
})
