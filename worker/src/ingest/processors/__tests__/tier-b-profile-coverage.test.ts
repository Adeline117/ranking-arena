import type { Job } from 'bullmq'
import type { ParsedHistoryRow, ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import {
  BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
  BINANCE_POSITION_HISTORY_URL,
} from '@/lib/ingest/adapters/binance/history-contract'
import { binancePositionHistoryTerminalVerifier } from '@/lib/ingest/adapters/binance/history-terminal'
import { POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT } from '@/lib/ingest/position-history-acquisition-v2'
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
const mockWritePositionHistoryRawArtifact = jest.fn()
const mockPersistPositionHistoryRawPointer = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockValidateStats = jest.fn()
const mockRoiCrossCheckOk = jest.fn()
const mockNextHistoryCursor = jest.fn()
const mockGetHistoryCursor = jest.fn()
const mockGetPositionHistoryPublicationCheckpoint = jest.fn()
const mockParseHistory = jest.fn()
const mockPublishHistoryRows = jest.fn()
const mockPublishTierBVerifiedPositionHistoryInTransaction = jest.fn()
const mockPublishProfile = jest.fn()
const mockDbQuery = jest.fn()
const mockIngestClientQuery = jest.fn()
const mockIngestClientRelease = jest.fn()
const mockQueueAdd = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
  ingestClientConnect: jest.fn(async () => ({
    query: (...args: unknown[]) => mockIngestClientQuery(...args),
    release: (...args: unknown[]) => mockIngestClientRelease(...args),
  })),
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
jest.mock('@/lib/ingest/core/history-cursor', () => ({
  nextHistoryCursor: (...args: unknown[]) => mockNextHistoryCursor(...args),
}))
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
  writePositionHistoryRawArtifact: (...args: unknown[]) =>
    mockWritePositionHistoryRawArtifact(...args),
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
  getPositionHistoryPublicationCheckpoint: (...args: unknown[]) =>
    mockGetPositionHistoryPublicationCheckpoint(...args),
  publishHistoryRows: (...args: unknown[]) => mockPublishHistoryRows(...args),
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
  publishTierBVerifiedPositionHistoryInTransaction: (...args: unknown[]) =>
    mockPublishTierBVerifiedPositionHistoryInTransaction(...args),
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

const exchangeTraderId = '0x0000000000000000000000000000000000000001'

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

const positionRow: ParsedHistoryRow = {
  kind: 'position_history',
  openedAt: '2026-07-15T10:00:00.000Z',
  closedAt: '2026-07-15T11:00:00.000Z',
  symbol: 'BTCUSDT',
  side: 'long',
  leverage: 2,
  size: 1,
  entryPrice: 100,
  exitPrice: 110,
  realizedPnl: 10,
  dedupeHash: 'position-1',
  raw: { id: 'position-1' },
}

const orderRow: ParsedHistoryRow = {
  kind: 'orders',
  ts: '2026-07-15T11:00:00.000Z',
  orderKind: 'close_long',
  symbol: 'BTCUSDT',
  side: 'long',
  price: 110,
  qty: 1,
  dedupeHash: 'order-1',
  raw: { id: 'order-1' },
}

async function* positionHistoryStream(options: { failAfterPage?: boolean } = {}) {
  yield {
    pageIndex: 1,
    payload: { data: [{ id: 'position-1' }], total: 1 },
    url: 'https://gtrade.test/history',
    fetchedAt: new Date(Date.now() + 1_000).toISOString(),
  }
  if (options.failAfterPage) throw new Error('history upstream failed')
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [{ segment_id: 'default', reason: 'reported_end' as const, page_ordinal: 1 }],
  }
}

async function* positionHistoryOverlapStream() {
  yield {
    pageIndex: 1,
    payload: { data: [{ id: 'position-1' }], total: 1 },
    url: 'https://gtrade.test/history',
    fetchedAt: new Date(Date.now() + 1_000).toISOString(),
  }
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [{ segment_id: 'default', reason: 'cursor_overlap' as const, page_ordinal: 1 }],
  }
}

async function* emptyPositionHistoryStream() {
  yield {
    pageIndex: 1,
    payload: { data: [], total: 0 },
    url: 'https://gtrade.test/history',
    fetchedAt: new Date(Date.now() + 1_000).toISOString(),
  }
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [{ segment_id: 'default', reason: 'reported_end' as const, page_ordinal: 1 }],
  }
}

function binancePositionRow(realizedPnl: string): Record<string, unknown> {
  const opened = Date.parse('2026-07-15T10:00:00.000Z')
  return {
    id: 'position-1',
    symbol: 'BTCUSDT',
    side: 'Long',
    status: 'All Closed',
    opened,
    closed: opened + 3_600_000,
    roi: '0.1',
    leverage: '2',
    closedVolume: '1',
    avgCost: '100',
    avgClosePrice: '110',
    closingPnl: realizedPnl,
  }
}

async function* binancePositionHistoryStream(
  options: { empty?: boolean; openingPnl?: string } = {}
) {
  const closingRows = options.empty ? [] : [binancePositionRow('10')]
  const openingRows = options.empty ? [] : [binancePositionRow(options.openingPnl ?? '10')]
  const payload = (sort: 'CLOSING' | 'OPENING', rows: Record<string, unknown>[]) => ({
    contract: BINANCE_HISTORY_PAGE_ENVELOPE_CONTRACT,
    portfolioId: exchangeTraderId,
    sort,
    request: { pageNumber: 1, pageSize: 50, portfolioId: exchangeTraderId, sort },
    response: {
      code: '000000',
      success: true,
      data: { list: rows, total: rows.length },
    },
  })
  yield {
    pageIndex: 1,
    payload: payload('CLOSING', closingRows),
    url: BINANCE_POSITION_HISTORY_URL,
    fetchedAt: new Date(Date.now() + 1_000).toISOString(),
  }
  yield {
    pageIndex: 1,
    payload: payload('OPENING', openingRows),
    url: BINANCE_POSITION_HISTORY_URL,
    fetchedAt: new Date(Date.now() + 2_000).toISOString(),
  }
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [
      { segment_id: 'closing', reason: 'reported_end' as const, page_ordinal: 1 },
      { segment_id: 'opening', reason: 'reported_end' as const, page_ordinal: 2 },
    ],
  }
}

async function* orderHistoryStream() {
  yield {
    pageIndex: 1,
    payload: { data: [{ id: 'order-1' }] },
    url: 'https://gtrade.test/orders',
    fetchedAt: new Date(Date.now() + 1_000).toISOString(),
  }
}

const job = { data: { sourceSlug: 'gtrade' } } as Job<TierJobData>
const binanceJob = { data: { sourceSlug: 'binance_futures' } } as Job<TierJobData>

function configureBinancePositionHistory(
  options: { empty?: boolean; openingPnl?: string } = {}
): SourceRow & { cadence_tier_b_seconds: number } {
  const binanceSource = {
    ...src,
    slug: 'binance_futures',
    adapter_slug: 'binance_futures',
    currency: 'USDT',
  }
  mockGetSourceBySlug.mockResolvedValue(binanceSource)
  mockProfileTimeframes.mockReturnValue([30])
  mockParseProfile.mockReturnValue(profile(30, true))
  mockGetHistory.mockImplementation(() => binancePositionHistoryStream(options))
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
    historyTerminalVerifier: () => binancePositionHistoryTerminalVerifier,
  })
  return binanceSource
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
    mockWritePositionHistoryRawArtifact.mockImplementation(
      async (
        _input: unknown,
        runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
      ) => runTransaction((transaction) => mockPersistPositionHistoryRawPointer(transaction))
    )
    mockPersistPositionHistoryRawPointer.mockResolvedValue({
      id: 2_081_897,
      storagePath: 'test/history/event.json.gz',
      contentHash: 'b'.repeat(64),
    })
    mockRecordStagingRejects.mockResolvedValue(undefined)
    mockValidateProfile.mockReturnValue([])
    mockValidateStats.mockImplementation((stats: unknown[]) => ({ valid: stats, rejects: [] }))
    mockRoiCrossCheckOk.mockReturnValue(null)
    mockPublishProfile.mockResolvedValue(undefined)
    mockQueueAdd.mockResolvedValue(undefined)
    mockIngestClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockIngestClientRelease.mockReturnValue(undefined)
    mockGetHistoryCursor.mockResolvedValue(null)
    mockGetPositionHistoryPublicationCheckpoint.mockResolvedValue({
      publicationId: null,
      cursor: null,
      observedAt: null,
    })
    mockNextHistoryCursor.mockReturnValue('2026-07-15T11:00:00.000Z')
    mockPublishHistoryRows.mockResolvedValue(1)
    mockPublishTierBVerifiedPositionHistoryInTransaction.mockResolvedValue({
      publicationId: 1,
      rowsWritten: 1,
      parsedRowCount: 1,
      cursor: '2026-07-15T11:00:00.000Z',
      observedAt: '2026-07-15T12:00:00.000Z',
      publishedAt: '2026-07-15T12:00:01.000Z',
      replayed: false,
    })
    mockGetLatestPassedNativeCohort.mockResolvedValue({
      traders: [
        {
          id: 42,
          exchange_trader_id: exchangeTraderId,
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

  it('keeps terminal-verified position history RAW-only until parser evidence is receipt-bound', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => positionHistoryStream())
    mockParseHistory.mockReturnValue([positionRow])
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
        verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
      }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      sourceRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
      artifact: {
        source: { id: 34, slug: 'gtrade' },
        trader: {
          id: 42,
          exchange_trader_id: '0x0000000000000000000000000000000000000001',
        },
        history_kind: 'position_history',
        termination: {
          evidence_state: 'verified',
          scan_terminal_state: 'exhausted',
        },
      },
    })
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetPositionHistoryPublicationCheckpoint).toHaveBeenCalledWith(34, 42)
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockIngestClientRelease).toHaveBeenCalledWith(false)
  })

  it('persists verified Binance history only as the outer @2 acquisition proof', async () => {
    configureBinancePositionHistory()

    await expect(processTierB(binanceJob)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 0,
    })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    const rawInput = mockWritePositionHistoryRawArtifact.mock.calls[0][0]
    expect(rawInput).toMatchObject({
      sourceRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
      artifact: {
        contract: POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
        acquisition: {
          source: { id: 34, slug: 'binance_futures' },
          trader: { id: 42, exchange_trader_id: exchangeTraderId },
          termination: { evidence_state: 'verified', scan_terminal_state: 'exhausted' },
        },
        candidate_ledger: {
          observed_candidate_count: 2,
          unique_source_fact_count: 1,
        },
      },
    })
    expect(rawInput.sourceRunId).not.toBe(rawInput.artifact.acquisition_source_run_id)
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('persists a verifier-proven empty Binance genesis as @2 without inferring rows', async () => {
    configureBinancePositionHistory({ empty: true })

    await expect(processTierB(binanceJob)).resolves.toMatchObject({
      historyRowsWritten: 0,
      errors: 0,
    })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        contract: POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT,
        candidate_ledger: {
          observed_candidate_count: 0,
          unique_source_fact_count: 0,
          source_facts: [],
        },
      },
    })
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('persists @1 and fails closed when Binance cross-segment economics conflict', async () => {
    configureBinancePositionHistory({ openingPnl: '999' })

    await expect(processTierB(binanceJob)).resolves.toMatchObject({
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        contract: 'arena.ingest.history-acquisition-artifact@1',
        termination: { evidence_state: 'verified' },
      },
    })
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('replays the exact outer @2 identity after an ambiguous COMMIT response', async () => {
    configureBinancePositionHistory()
    let commitAttempts = 0
    mockIngestClientQuery.mockImplementation(async (sql: unknown) => {
      if (sql === 'COMMIT' && commitAttempts++ === 0) {
        throw new Error('connection lost after COMMIT')
      }
      return { rows: [], rowCount: 0 }
    })

    await expect(processTierB(binanceJob)).resolves.toMatchObject({ errors: 0 })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(2)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[1][0]).toEqual(
      mockWritePositionHistoryRawArtifact.mock.calls[0][0]
    )
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'COMMIT',
      'BEGIN',
      'COMMIT',
    ])
    expect(mockIngestClientRelease.mock.calls.map(([destroy]) => destroy)).toEqual([true, false])
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('replays the exact outer @2 identity after a known pointer rollback', async () => {
    configureBinancePositionHistory()
    mockPersistPositionHistoryRawPointer
      .mockRejectedValueOnce(new Error('pointer insert rejected'))
      .mockResolvedValueOnce({
        id: 2_081_897,
        storagePath: 'test/history/event.json.gz',
        contentHash: 'b'.repeat(64),
      })

    await expect(processTierB(binanceJob)).resolves.toMatchObject({ errors: 0 })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(2)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[1][0]).toEqual(
      mockWritePositionHistoryRawArtifact.mock.calls[0][0]
    )
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'ROLLBACK',
      'BEGIN',
      'COMMIT',
    ])
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('bounds RAW pointer reconciliation to one replay and surfaces aggregate failure', async () => {
    configureBinancePositionHistory()
    mockPersistPositionHistoryRawPointer.mockRejectedValue(
      new Error('pointer database unavailable')
    )

    await expect(processTierB(binanceJob)).resolves.toMatchObject({ errors: 1 })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(2)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[1][0]).toEqual(
      mockWritePositionHistoryRawArtifact.mock.calls[0][0]
    )
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'ROLLBACK',
      'BEGIN',
      'ROLLBACK',
    ])
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('does not advance an overlap cursor without receipt-bound parser evidence', async () => {
    const cursor = '2026-07-15T11:00:00.000Z'
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => positionHistoryOverlapStream())
    mockParseHistory.mockReturnValue([positionRow])
    mockNextHistoryCursor.mockReturnValue(null)
    mockGetPositionHistoryPublicationCheckpoint.mockResolvedValue({
      publicationId: 91,
      cursor,
      observedAt: '2026-07-15T11:30:00.000Z',
    })
    mockPublishTierBVerifiedPositionHistoryInTransaction.mockResolvedValue({
      publicationId: 92,
      rowsWritten: 1,
      parsedRowCount: 1,
      cursor,
      observedAt: '2026-07-15T12:00:00.000Z',
      publishedAt: '2026-07-15T12:00:01.000Z',
      replayed: false,
    })
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
        verify: () => ({
          verified: true,
          scanTerminalState: 'cursor_overlap',
          overlapEventAt: cursor,
        }),
      }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('does not infer parser-complete from a terminal-verified empty payload', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => emptyPositionHistoryStream())
    mockParseHistory.mockReturnValue([])
    mockNextHistoryCursor.mockReturnValue(null)
    mockPublishTierBVerifiedPositionHistoryInTransaction.mockResolvedValue({
      publicationId: 1,
      rowsWritten: 0,
      parsedRowCount: 0,
      cursor: null,
      observedAt: '2026-07-15T12:00:00.000Z',
      publishedAt: '2026-07-15T12:00:01.000Z',
      replayed: false,
    })
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
        verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
      }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('keeps non-position histories on the legacy compatibility cursor path', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistoryCursor.mockResolvedValue('2026-07-14T11:00:00.000Z')
    mockGetHistory.mockImplementation(() => orderHistoryStream())
    mockParseHistory.mockReturnValue([orderRow])
    mockNextHistoryCursor.mockReturnValue('2026-07-15T11:00:00.000Z')
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
      parseHistory: mockParseHistory,
      validateProfile: mockValidateProfile,
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 1,
      errors: 0,
    })

    expect(mockGetPositionHistoryPublicationCheckpoint).not.toHaveBeenCalled()
    expect(mockGetHistoryCursor).toHaveBeenCalledWith(42, 'orders')
    expect(mockPublishHistoryRows).toHaveBeenCalledWith(
      src,
      42,
      'orders',
      [orderRow],
      '2026-07-15T11:00:00.000Z'
    )
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
  })

  it('keeps unverified history as RAW-only audit evidence', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => positionHistoryStream())
    mockParseHistory.mockReturnValue([positionRow])
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
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 0,
    })

    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        termination: {
          evidence_state: 'verifier_missing',
          scan_terminal_state: 'unknown',
          blocker_reasons: ['terminal_verifier_missing'],
        },
      },
    })
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('persists upstream-error position-history RAW without parsing or cursor progress', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => positionHistoryStream({ failAfterPage: true }))
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
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        pages: [expect.any(Object)],
        termination: {
          evidence_state: 'upstream_error',
          scan_terminal_state: 'partial',
          blocker_reasons: ['upstream_error'],
        },
      },
    })
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('fails closed before invoking a page parser after Storage upload', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => positionHistoryStream())
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
        verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
      }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishTierBVerifiedPositionHistoryInTransaction).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
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
