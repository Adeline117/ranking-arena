import type { Job } from 'bullmq'
import type { ParsedProfile, ParsedStats, SourceRow } from '@/lib/ingest/core/types'
import {
  PROFILE_CAPTURE_CONTRACT_DOCUMENT,
  type ProfileCaptureContract,
} from '@/lib/ingest/profile-capture/contract'
import type { TierJobData } from '../../queues'

const mockGetSourceBySlug = jest.fn()
const mockProfileTimeframes = jest.fn()
const mockGetLatestPassedNativeCohort = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockParseProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockWriteRawObject = jest.fn()
const mockPublishProfile = jest.fn()
const mockDbQuery = jest.fn()
const mockContract = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
  ingestClientConnect: jest.fn(),
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
  getCircuit: () => ({ recordParseFailure: jest.fn() }),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
  writeCopierSnapshotRawArtifact: jest.fn(),
  writePositionHistoryRawArtifact: jest.fn(),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  getHistoryCursor: jest.fn(),
  publishHistoryRows: jest.fn(),
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
const mockRecordStagingRejects = jest.fn()
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/field-inventory', () => ({
  recordFieldInventory: jest.fn(async () => undefined),
}))
jest.mock('@/lib/ingest/profile-capture/contract', () => ({
  ...jest.requireActual('@/lib/ingest/profile-capture/contract'),
  getProfileCaptureContract: (...args: unknown[]) => mockContract(...args),
}))
jest.mock('../../queues', () => ({
  getRegionQueue: jest.fn(() => ({ add: jest.fn() })),
  INGEST_JOB: { TIER_B: 'tier-b' },
}))

import { processTierB as processTierBInRegion } from '../tier-b-profiles'
import { UpstreamGoneError } from '@/lib/ingest/fetch/capture'
import { createConsumedRegionContext } from '../../consumed-region-context'

const processTierB = (job: Parameters<typeof processTierBInRegion>[0]) =>
  processTierBInRegion(job, createConsumedRegionContext('local', 'local'))

const src = {
  id: 7,
  slug: 'alpha_futures',
  adapter_slug: 'alpha',
  status: 'active',
  currency: 'USDT',
  tf_label_map: {},
  meta: {},
  timeframes_native: [90],
  timeframes_derived: [],
  deep_profile_topn: 300,
  cadence_tier_b_seconds: 21_600,
  fetch_region: 'local',
  serving_mode: 'serving',
} as SourceRow & { cadence_tier_b_seconds: number }
const job = { data: { sourceSlug: 'alpha_futures' } } as Job<TierJobData>

const CONTRACT: ProfileCaptureContract = {
  document: PROFILE_CAPTURE_CONTRACT_DOCUMENT,
  captureContract: 'alpha_futures-profile-capture@1',
  sourceSlug: 'alpha_futures',
  timeframes: [90],
  endpoints: [
    {
      id: 'detail',
      origin: 'https://api.alpha.example',
      pathname: '/v1/detail',
      queryAllowlist: ['uid', 'range'],
      required: true,
    },
  ],
  metrics: {
    mdd: { endpoint: 'detail', path: ['data', 'mdd'], transform: 'abs_fraction_to_percent' },
    win_rate: { endpoint: 'detail', path: ['data', 'win'], transform: 'identity' },
  },
}

function block(timeframe: 7 | 90, mdd: number | null): ParsedStats {
  return {
    timeframe,
    asOf: '2026-07-15T12:00:00.000Z',
    roi: 10,
    pnl: 100,
    sharpe: null,
    mdd,
    winRate: 55,
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
  }
}

function profileOf(stats: ParsedStats): ParsedProfile {
  return { stats: [stats], series: [], nickname: null, avatarUrlOrigin: null }
}

const sql = (call: unknown[]) => String(call[0])
const finishCalls = () =>
  mockDbQuery.mock.calls.filter((call) => sql(call).includes('finish_profile_acquisition_attempt'))
const startCalls = () =>
  mockDbQuery.mock.calls.filter((call) => sql(call).includes('start_profile_acquisition_attempt'))

describe('Tier-B attempt-bound profile evidence', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockGetSourceBySlug.mockResolvedValue(src)
    mockProfileTimeframes.mockReturnValue([90])
    mockContract.mockReturnValue(CONTRACT)
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: true,
        positionHistory: false,
        orders: false,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: jest.fn(),
      parseProfile: mockParseProfile,
    })
    mockGetProfile.mockImplementation(async () => ({
      pages: [
        {
          pageIndex: 0,
          payload: { code: 0, data: { mdd: -0.2, win: 55 } },
          url: 'https://api.alpha.example/v1/detail?uid=T1&range=90&ts=1',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    }))
    mockParseProfile.mockReturnValue(profileOf(block(90, 20)))
    mockOpenSession.mockResolvedValue({ close: jest.fn(async () => undefined) })
    mockWriteRawObject.mockResolvedValue({
      id: 5_001,
      storagePath: 'x',
      contentHash: 'a'.repeat(64),
    })
    mockPublishProfile.mockResolvedValue(undefined)
    mockGetLatestPassedNativeCohort.mockResolvedValue({
      traders: [{ id: 42, exchange_trader_id: 'T1', meta: null, headline_rois: {} }],
      nativeTimeframes: [90],
      foundTimeframes: [90],
      missingTimeframes: [],
    })
    mockDbQuery.mockImplementation(async (text: string, values: unknown[] = []) => {
      if (text.includes('start_profile_acquisition_attempt')) {
        return { rows: [{ attempt_seq: '77', recorded_started_at: new Date() }], rowCount: 1 }
      }
      if (text.includes('finish_profile_acquisition_attempt')) {
        return { rows: [{ terminal_state: values[2] }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    })
  })

  it('records a complete attempt and stamps exactly the attested metrics', async () => {
    await processTierB(job)

    const [start] = startCalls()
    const attemptId = (start[1] as unknown[])[0]
    expect((start[1] as unknown[]).slice(1, 5)).toEqual([7, 42, 90, CONTRACT.captureContract])
    expect(mockWriteRawObject.mock.calls[0][0].meta).toEqual({
      profile_capture: { attempt_id: attemptId, capture_contract: CONTRACT.captureContract },
    })
    const [finish] = finishCalls()
    const [seq, id, state, reason, raw, run, manifest] = finish[1] as unknown[]
    expect([seq, id, state, reason, raw]).toEqual([77, attemptId, 'complete', null, 5_001])
    expect(run).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(String(manifest)).metrics).toEqual({
      mdd: { endpoint: 'detail', path: ['data', 'mdd'], raw_value: -0.2, value: 20 },
      win_rate: { endpoint: 'detail', path: ['data', 'win'], raw_value: 55, value: 55 },
    })
    expect(mockPublishProfile).toHaveBeenCalledTimes(1)
    expect(mockPublishProfile.mock.calls[0][3]).toEqual({
      fullSeries: true,
      evidence: { attemptSeq: 77, timeframe: 90, metrics: ['mdd', 'win_rate'] },
    })
  })

  it('counts and records a contracted drawdown above 100 % that staging stores NULL', async () => {
    // The source reports a 132.54 % drawdown: the capture is complete, the
    // block is published with mdd NULL, and only the win rate is attested.
    mockGetProfile.mockImplementation(async () => ({
      pages: [
        {
          pageIndex: 0,
          payload: { code: 0, data: { mdd: -1.3254, win: 55 } },
          url: 'https://api.alpha.example/v1/detail?uid=T1&range=90&ts=1',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    }))
    mockParseProfile.mockReturnValue(profileOf(block(90, 132.54)))

    const result = await processTierB(job)

    expect(result).toMatchObject({ nulledMetrics: 1, rejects: 0, errors: 0, surfacesFetched: 1 })
    const [finish] = finishCalls()
    expect((finish[1] as unknown[])[2]).toBe('complete')
    expect(mockPublishProfile).toHaveBeenCalledTimes(1)
    expect(mockPublishProfile.mock.calls[0][2].stats[0].mdd).toBeNull()
    expect(mockPublishProfile.mock.calls[0][3].evidence).toEqual({
      attemptSeq: 77,
      timeframe: 90,
      metrics: ['win_rate'],
    })
    expect(mockRecordStagingRejects).toHaveBeenCalledTimes(1)
    expect(mockRecordStagingRejects).toHaveBeenCalledWith(7, 5_001, [
      {
        reason: 'metric_out_of_range:mdd',
        payload: {
          source_slug: 'alpha_futures',
          trader_id: 42,
          exchange_trader_id: 'T1',
          timeframe: 90,
          metric: 'mdd',
          source_value: 132.54,
          action: 'stored_null_not_attested',
        },
      },
    ])
  })

  it('still publishes when the out-of-range audit write fails', async () => {
    mockParseProfile.mockReturnValue(profileOf(block(90, 132.54)))
    mockGetProfile.mockImplementation(async () => ({
      pages: [
        {
          pageIndex: 0,
          payload: { code: 0, data: { mdd: -1.3254, win: 55 } },
          url: 'https://api.alpha.example/v1/detail?uid=T1&range=90&ts=1',
          fetchedAt: '2026-07-15T12:00:00.000Z',
        },
      ],
      fetchedAt: '2026-07-15T12:00:00.000Z',
    }))
    mockRecordStagingRejects.mockRejectedValueOnce(new Error('staging audit unavailable'))

    const result = await processTierB(job)

    expect(result).toMatchObject({ nulledMetrics: 1, errors: 0 })
    expect(mockPublishProfile).toHaveBeenCalledTimes(1)
  })

  it('counts an out-of-range metric the contract does not declare without a staging record', async () => {
    mockContract.mockReturnValue(null)
    mockParseProfile.mockReturnValue(profileOf(block(90, 132.54)))

    const result = await processTierB(job)

    expect(result).toMatchObject({ nulledMetrics: 1, errors: 0 })
    expect(mockRecordStagingRejects).not.toHaveBeenCalled()
    expect(mockPublishProfile.mock.calls[0][2].stats[0].mdd).toBeNull()
  })

  it('records a mismatch as processing_failed and publishes unattested', async () => {
    mockParseProfile.mockReturnValue(profileOf(block(90, 25)))

    await processTierB(job)

    const [finish] = finishCalls()
    expect((finish[1] as unknown[]).slice(2, 7)).toEqual([
      'processing_failed',
      'projection_mismatch',
      5_001,
      null,
      null,
    ])
    expect(mockPublishProfile.mock.calls[0][3]).toEqual({ fullSeries: true, evidence: null })
  })

  it('records an upstream failure as a typed terminal without RAW or publish', async () => {
    mockGetProfile.mockRejectedValue(
      new UpstreamGoneError(404, 'https://api.alpha.example/v1/detail')
    )

    await processTierB(job)

    const [finish] = finishCalls()
    expect((finish[1] as unknown[]).slice(2, 5)).toEqual(['upstream_failed', 'upstream_gone', null])
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishProfile).not.toHaveBeenCalled()
  })

  it('publishes unattested when the database refuses to start the attempt', async () => {
    mockDbQuery.mockImplementation(async (text: string) => {
      if (text.includes('start_profile_acquisition_attempt')) {
        throw new Error('profile capture contract is not registered')
      }
      return { rows: [], rowCount: 1 }
    })

    await processTierB(job)

    expect(finishCalls()).toHaveLength(0)
    expect(mockWriteRawObject.mock.calls[0][0].meta).toBeUndefined()
    expect(mockPublishProfile.mock.calls[0][3]).toEqual({ fullSeries: true, evidence: null })
  })

  it('never opens an attempt for a source without a contract or an uncovered timeframe', async () => {
    mockProfileTimeframes.mockReturnValue([7])
    mockParseProfile.mockReturnValue(profileOf(block(7, 20)))
    await processTierB(job)
    mockContract.mockReturnValue(null)
    mockProfileTimeframes.mockReturnValue([90])
    mockParseProfile.mockReturnValue(profileOf(block(90, 20)))
    await processTierB(job)

    expect(startCalls()).toHaveLength(0)
    expect(mockPublishProfile.mock.calls.map((call) => call[3])).toEqual([
      { fullSeries: true, evidence: null },
      { fullSeries: true, evidence: null },
    ])
  })
})
