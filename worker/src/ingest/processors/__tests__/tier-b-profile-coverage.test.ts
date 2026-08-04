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
const mockWriteHistoryRawArtifact = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockValidateStats = jest.fn()
const mockRoiCrossCheckOk = jest.fn()
const mockParseHistory = jest.fn()
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
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
  writeHistoryRawArtifact: (...args: unknown[]) => mockWriteHistoryRawArtifact(...args),
}))
jest.mock('@/lib/ingest/staging/validate', () => ({
  roiCrossCheckOk: (...args: unknown[]) => mockRoiCrossCheckOk(...args),
  validateStats: (...args: unknown[]) => mockValidateStats(...args),
}))
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: jest.fn(async () => undefined),
}))
jest.mock('../../queues', () => ({
  getRegionQueue: jest.fn(() => ({ add: (...args: unknown[]) => mockQueueAdd(...args) })),
  INGEST_JOB: { TIER_B: 'tier-b' },
}))

import { processTierB as processTierBInRegion } from '../tier-b-profiles'
import { createConsumedRegionContext } from '../../consumed-region-context'

const processTierB = (job: Parameters<typeof processTierBInRegion>[0]) =>
  processTierBInRegion(job, createConsumedRegionContext('local', 'local'))

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

async function* historyStream(options: { failAfterPage?: boolean; omitClaim?: boolean } = {}) {
  yield {
    pageIndex: 1,
    payload: { data: [{ id: 'history-fact-1' }], total: 1 },
    url: 'https://gtrade.test/history?page=1',
    fetchedAt: new Date(Date.now() + 1_000).toISOString(),
  }
  if (options.failAfterPage) throw new Error('history upstream failed')
  if (options.omitClaim) return undefined
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [{ segment_id: 'default', reason: 'reported_end' as const, page_ordinal: 1 }],
  }
}

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
    mockWriteHistoryRawArtifact.mockResolvedValue({
      id: 2_081_897,
      storagePath: 'test/history/event_history.json.gz',
      contentHash: 'b'.repeat(64),
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

  it('rejects a moved source before selecting traders or opening a session', async () => {
    mockGetSourceBySlug.mockResolvedValue({ ...src, fetch_region: 'vps_sg' })

    await expect(processTierB(job)).rejects.toThrow(
      'belongs to vps_sg, not consumed queue region local'
    )
    expect(mockGetLatestPassedNativeCohort).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
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

  it('persists a verified history capture but never uses the legacy typed publisher or cursor', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => historyStream())
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: true,
        orders: false,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
      validateProfile: mockValidateProfile,
      historyTerminalVerifier: () => ({
        contract: 'arena.ingest.history-terminal-verifier.test.position_history@1',
        verify: () => ({ verified: true, scanTerminalState: 'exhausted' as const }),
      }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 0,
    })

    expect(mockGetHistory).toHaveBeenCalledWith(
      expect.anything(),
      src,
      '0x0000000000000000000000000000000000000001',
      'position_history',
      null,
      null
    )
    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      sourceRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
      artifact: {
        source: { id: 34, slug: 'gtrade' },
        trader: {
          id: 42,
          exchange_trader_id: '0x0000000000000000000000000000000000000001',
        },
        history_kind: 'position_history',
        starting_cursor: null,
        termination: {
          evidence_state: 'verified',
          scan_terminal_state: 'exhausted',
        },
      },
    })
    expect(mockWriteHistoryRawArtifact.mock.calls[0][1]).toEqual(expect.any(Function))
    expect(mockParseHistory).not.toHaveBeenCalled()
  })

  it('keeps every unsupported-verifier history kind RAW-only', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => historyStream())
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: false,
        orders: true,
        transfers: true,
        copiers: true,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
      validateProfile: mockValidateProfile,
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 0,
    })

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(3)
    expect(
      mockWriteHistoryRawArtifact.mock.calls.map(([input]) => ({
        kind: input.artifact.history_kind,
        state: input.artifact.termination.evidence_state,
        cursor: input.artifact.starting_cursor,
      }))
    ).toEqual([
      { kind: 'orders', state: 'verifier_missing', cursor: null },
      { kind: 'transfers', state: 'verifier_missing', cursor: null },
      { kind: 'copiers', state: 'verifier_missing', cursor: null },
    ])
    expect(mockParseHistory).not.toHaveBeenCalled()
  })

  it('persists upstream-error evidence before reporting the history failure', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => historyStream({ failAfterPage: true }))
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: true,
        orders: false,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
      validateProfile: mockValidateProfile,
      historyTerminalVerifier: () => ({
        contract: 'arena.ingest.history-terminal-verifier.test.position_history@1',
        verify: () => ({ verified: true, scanTerminalState: 'exhausted' as const }),
      }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        termination: {
          evidence_state: 'upstream_error',
          scan_terminal_state: 'partial',
          blocker_reasons: ['upstream_error'],
        },
      },
    })
    expect(mockParseHistory).not.toHaveBeenCalled()
  })

  it('continues capturing other history kinds after one kind fails', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation((_session, _source, _trader, kind: string) =>
      historyStream({ failAfterPage: kind === 'position_history' })
    )
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: true,
        orders: true,
        transfers: true,
        copiers: true,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
      validateProfile: mockValidateProfile,
      historyTerminalVerifier: (_source: SourceRow, kind: string) =>
        kind === 'position_history'
          ? {
              contract: 'arena.ingest.history-terminal-verifier.test.position_history@1',
              verify: () => ({ verified: true, scanTerminalState: 'exhausted' as const }),
            }
          : null,
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockGetHistory.mock.calls.map((call) => call[3])).toEqual([
      'position_history',
      'orders',
      'transfers',
      'copiers',
    ])
    expect(
      mockWriteHistoryRawArtifact.mock.calls.map(([input]) => ({
        kind: input.artifact.history_kind,
        state: input.artifact.termination.evidence_state,
      }))
    ).toEqual([
      { kind: 'position_history', state: 'upstream_error' },
      { kind: 'orders', state: 'verifier_missing' },
      { kind: 'transfers', state: 'verifier_missing' },
      { kind: 'copiers', state: 'verifier_missing' },
    ])
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
    expect(mockWriteHistoryRawArtifact).not.toHaveBeenCalled()
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
    expect(mockWriteHistoryRawArtifact).not.toHaveBeenCalled()
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
