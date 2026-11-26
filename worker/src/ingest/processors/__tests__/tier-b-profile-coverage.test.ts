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
const mockRecordParseFailure = jest.fn()
const mockWriteRawObject = jest.fn()
const mockWriteCopierSnapshotRawArtifact = jest.fn()
const mockWritePositionHistoryRawArtifact = jest.fn()
const mockPersistPositionHistoryRawPointer = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockValidateStats = jest.fn()
const mockRoiCrossCheckOk = jest.fn()
const mockNextHistoryCursor = jest.fn()
const mockGetHistoryCursor = jest.fn()
const mockParseHistory = jest.fn()
const mockPublishHistoryRows = jest.fn()
const mockPublishCopierSnapshot = jest.fn()
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
  getCircuit: () => ({ recordParseFailure: mockRecordParseFailure }),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
  writeCopierSnapshotRawArtifact: (...args: unknown[]) =>
    mockWriteCopierSnapshotRawArtifact(...args),
  writePositionHistoryRawArtifact: (...args: unknown[]) =>
    mockWritePositionHistoryRawArtifact(...args),
}))
jest.mock('@/lib/ingest/serving/copier-snapshot-publish', () => ({
  publishCopierSnapshotInTransaction: (...args: unknown[]) => mockPublishCopierSnapshot(...args),
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
  publishHistoryRows: (...args: unknown[]) => mockPublishHistoryRows(...args),
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
import { UpstreamGoneError } from '@/lib/ingest/fetch/capture'
import {
  CopierPageCapReachedError,
  HistoryPageCapReachedError,
} from '@/lib/ingest/core/history-page-cap'
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
  copier_table_depth: 'full',
  serving_mode: 'serving',
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

const copierRow: Extract<ParsedHistoryRow, { kind: 'copiers' }> = {
  kind: 'copiers',
  ts: '2026-07-15T09:00:00.000Z',
  copierLabel: 'private-user@example.com',
  copierPnl: 125,
  copierInvested: 1_000,
  copyDurationDays: 30,
  dedupeHash: 'copier-1',
  raw: { userId: 'private-1' },
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

async function* noHistoryEvidenceStream() {
  return undefined
}

const job = { data: { sourceSlug: 'gtrade' } } as Job<TierJobData>
const binanceJob = { data: { sourceSlug: 'binance_futures' } } as Job<TierJobData>
const bingxSource = { ...src, id: 21, slug: 'bingx_futures', adapter_slug: 'bingx' }
const bingxJob = { data: { sourceSlug: 'bingx_futures' } } as Job<TierJobData>

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

function configureCopierHistory(): void {
  mockProfileTimeframes.mockReturnValue([30])
  mockParseProfile.mockReturnValue(profile(30, true))
  mockGetAdapter.mockReturnValue({
    capabilities: {
      profile: true,
      positionHistory: false,
      orders: false,
      transfers: false,
      copiers: true,
    },
    getProfile: mockGetProfile,
    getHistory: mockGetHistory,
    parseProfile: mockParseProfile,
    parseHistory: mockParseHistory,
    validateProfile: mockValidateProfile,
  })
}

function tierBProfileMarkerCalls(): unknown[][] {
  return mockDbQuery.mock.calls.filter(([sql]) =>
    String(sql).includes('INSERT INTO arena.ingest_cursors')
  )
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
    mockWriteCopierSnapshotRawArtifact.mockResolvedValue({
      id: 2_081_898,
      storagePath: 'gtrade/copier_snapshot/tier_b/test.json.gz',
      contentHash: 'c'.repeat(64),
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
    mockNextHistoryCursor.mockReturnValue('2026-07-15T11:00:00.000Z')
    mockPublishHistoryRows.mockResolvedValue(1)
    mockPublishCopierSnapshot.mockResolvedValue({
      publicationId: 3_001,
      publishedAt: '2026-07-15T12:00:01.000Z',
      parsedRowCount: 1,
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

  it('skips sources with neither profiles nor scheduled history surfaces', async () => {
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: false,
        positionHistory: false,
        orders: false,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
    })

    await expect(processTierB(job)).resolves.toEqual({
      tradersCrawled: 0,
      surfacesFetched: 0,
      historyRowsWritten: 0,
      rejects: 0,
      errors: 0,
      crossCheckFails: 0,
      crossCheckSkipped: 0,
      remaining: 0,
    })

    expect(mockGetLatestPassedNativeCohort).not.toHaveBeenCalled()
    expect(mockProfileTimeframes).not.toHaveBeenCalled()
    expect(mockOpenSession).not.toHaveBeenCalled()
  })

  it('schedules declared histories for a record-only adapter', async () => {
    mockGetSourceBySlug.mockResolvedValue(bingxSource)
    mockGetHistory.mockImplementation(() => orderHistoryStream())
    mockParseHistory.mockReturnValue([orderRow])
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: false,
        positionHistory: false,
        orders: true,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
    })

    await expect(processTierB(bingxJob)).resolves.toMatchObject({
      tradersCrawled: 1,
      surfacesFetched: 0,
      historyRowsWritten: 1,
      errors: 0,
    })

    expect(mockProfileTimeframes).not.toHaveBeenCalled()
    expect(mockGetProfile).not.toHaveBeenCalled()
    expect(mockGetHistory).toHaveBeenCalledWith(
      expect.anything(),
      bingxSource,
      exchangeTraderId,
      'orders',
      null,
      null
    )
    expect(mockPublishHistoryRows).toHaveBeenCalledWith(
      bingxSource,
      42,
      'orders',
      [orderRow],
      '2026-07-15T11:00:00.000Z'
    )
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })

  it('does not mark a record-only trader fresh without an upstream response page', async () => {
    mockGetSourceBySlug.mockResolvedValue(bingxSource)
    mockGetHistory.mockImplementation(() => noHistoryEvidenceStream())
    mockGetAdapter.mockReturnValue({
      capabilities: {
        profile: false,
        positionHistory: false,
        orders: true,
        transfers: false,
        copiers: false,
      },
      getProfile: mockGetProfile,
      getHistory: mockGetHistory,
      parseProfile: mockParseProfile,
      parseHistory: mockParseHistory,
    })

    await expect(processTierB(bingxJob)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 0,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockGetProfile).not.toHaveBeenCalled()
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(false)
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

  it('never publishes a page-budget-cut copier capture as a Tier-B snapshot, but records the cut', async () => {
    configureCopierHistory()
    mockGetHistory.mockImplementation(async function* () {
      yield* positionHistoryStream()
      throw new CopierPageCapReachedError('gtrade', 30)
    })
    mockParseHistory.mockReturnValue([copierRow])

    await expect(processTierB(job)).resolves.toMatchObject({ errors: 0 })

    expect(mockWriteCopierSnapshotRawArtifact).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'history:copiers',
        meta: expect.objectContaining({ capture_rejected: 'caller_page_budget', page_cap: 30 }),
      })
    )
    const marker = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("'copiers_truncated'")
    )
    expect(marker?.[1]).toEqual([42, 30, 1])
  })

  it('commits a complete copier snapshot before marking the whole trader fresh', async () => {
    configureCopierHistory()
    mockGetHistory.mockImplementation(() => positionHistoryStream())
    mockParseHistory.mockReturnValue([copierRow])

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 1,
      surfacesFetched: 1,
      historyRowsWritten: 1,
      errors: 0,
    })

    expect(mockGetHistory).toHaveBeenCalledWith(
      expect.anything(),
      src,
      exchangeTraderId,
      'copiers',
      null,
      null
    )
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    // Only the profile uses the generic RAW path. The copier snapshot has a
    // strict-canonical artifact and a dedicated pointer contract.
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierSnapshotRawArtifact).toHaveBeenCalledTimes(1)
    const [rawInput, rawRunner] = mockWriteCopierSnapshotRawArtifact.mock.calls[0]
    expect(rawInput).toMatchObject({
      artifact: {
        contract: 'arena.ingest.copier-snapshot-artifact@1',
        source: {
          id: 34,
          slug: 'gtrade',
          currency: 'USDC',
          copier_table_depth: 'full',
          fetch_region: 'local',
        },
        trader: {
          id: 42,
          exchange_trader_id: exchangeTraderId,
        },
        lane: 'tier_b',
        request_timeframe: null,
        page_count: 1,
        scan_terminal_state: 'stream_exhausted_unverified',
        caller_limited: false,
        source_reported_row_count: null,
      },
    })
    expect(rawRunner).toEqual(expect.any(Function))
    expect(mockPublishCopierSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function) }),
      {
        artifact: rawInput.artifact,
        rawReceipt: {
          id: 2_081_898,
          storagePath: 'gtrade/copier_snapshot/tier_b/test.json.gz',
          contentHash: 'c'.repeat(64),
        },
        rows: [copierRow],
      }
    )
    expect(tierBProfileMarkerCalls()).toHaveLength(1)
    expect(mockWriteCopierSnapshotRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseHistory.mock.invocationCallOrder[0]
    )
    expect(mockParseHistory.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishCopierSnapshot.mock.invocationCallOrder[0]
    )
    expect(mockPublishCopierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockDbQuery.mock.invocationCallOrder[0]
    )
  })

  it('does not count or mark a trader fresh when private copier publication fails', async () => {
    configureCopierHistory()
    mockGetHistory.mockImplementation(() => positionHistoryStream())
    mockParseHistory.mockReturnValue([copierRow])
    mockPublishCopierSnapshot.mockRejectedValue(new Error('private copier commit failed'))

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWriteCopierSnapshotRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockPublishCopierSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK'])
  })

  it('keeps a zero-page copier capture diagnostic-only and retryable', async () => {
    configureCopierHistory()
    mockGetHistory.mockImplementation(() => noHistoryEvidenceStream())

    await expect(processTierB(job)).resolves.toMatchObject({
      tradersCrawled: 0,
      surfacesFetched: 1,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'history:copiers',
        traderId: 42,
        timeframe: null,
        payload: [],
        meta: expect.objectContaining({
          surface: 'copiers',
          lane: 'tier_b',
          fetch_failed: false,
          capture_rejected: 'no_evidence_page',
        }),
      })
    )
    expect(mockWriteCopierSnapshotRawArtifact).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
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
      tradersCrawled: 0,
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
    expect(mockGetHistory).toHaveBeenCalledWith(
      expect.anything(),
      src,
      exchangeTraderId,
      'position_history',
      null,
      null
    )
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockIngestClientRelease).toHaveBeenCalledWith(false)
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
  })

  it('persists @1 and fails closed when Binance cross-segment economics conflict', async () => {
    configureBinancePositionHistory({ openingPnl: '999' })

    await expect(processTierB(binanceJob)).resolves.toMatchObject({
      tradersCrawled: 0,
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
  })

  it('bounds RAW pointer reconciliation to one replay and surfaces aggregate failure', async () => {
    configureBinancePositionHistory()
    mockPersistPositionHistoryRawPointer.mockRejectedValue(
      new Error('pointer database unavailable')
    )

    await expect(processTierB(binanceJob)).resolves.toMatchObject({
      tradersCrawled: 0,
      errors: 1,
    })

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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
  })

  it('does not inherit a legacy overlap cursor into the @2 evidence genesis', async () => {
    const cursor = '2026-07-15T11:00:00.000Z'
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => positionHistoryOverlapStream())
    mockParseHistory.mockReturnValue([positionRow])
    mockNextHistoryCursor.mockReturnValue(null)
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
      errors: 0,
    })

    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetHistory).toHaveBeenCalledWith(
      expect.anything(),
      src,
      exchangeTraderId,
      'position_history',
      null,
      null
    )
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        starting_cursor: null,
        termination: { evidence_state: 'rejected' },
      },
    })
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0].artifact.contract).not.toBe(
      POSITION_HISTORY_ACQUISITION_ARTIFACT_V2_CONTRACT
    )
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
  })

  it('does not infer parser-complete from a terminal-verified empty payload', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(() => emptyPositionHistoryStream())
    mockParseHistory.mockReturnValue([])
    mockNextHistoryCursor.mockReturnValue(null)
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
      tradersCrawled: 0,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
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

    expect(mockGetHistoryCursor).toHaveBeenCalledWith(42, 'orders')
    expect(mockPublishHistoryRows).toHaveBeenCalledWith(
      src,
      42,
      'orders',
      [orderRow],
      '2026-07-15T11:00:00.000Z'
    )
  })

  it('publishes a page-cap-cut orders crawl and records the truncation (not silent)', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistoryCursor.mockResolvedValue(null)
    mockGetHistory.mockImplementation(async function* () {
      yield* orderHistoryStream()
      throw new HistoryPageCapReachedError('gtrade', 'orders', 25)
    })
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
    expect(mockPublishHistoryRows).toHaveBeenCalledWith(
      src,
      42,
      'orders',
      [orderRow],
      '2026-07-15T11:00:00.000Z'
    )
    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'history:orders',
        meta: expect.objectContaining({ caller_limited: true, page_cap: 25, fetch_failed: false }),
      })
    )
    const truncation = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("'history_truncated'")
    )
    expect(truncation).toBeDefined()
    expect(truncation?.[1]).toEqual([
      42,
      'orders',
      25,
      expect.anything(),
      // The mock adapter declares no continuation: recorded explicitly (#440).
      JSON.stringify({ state: 'unsupported', reason: 'adapter_not_wired' }),
    ])
  })

  it('runs one bounded backward continuation after a complete forward pass (#440)', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistoryCursor.mockResolvedValue('2026-07-15T10:00:00.000Z')
    const olderRow: ParsedHistoryRow = {
      ...orderRow,
      ts: '2026-07-01T00:00:00.000Z',
      dedupeHash: 'o2',
    }
    mockGetHistory.mockImplementation(async function* (...args: unknown[]) {
      if (args[6] === undefined) {
        yield* orderHistoryStream()
        return
      }
      yield { pageIndex: 20, payload: 'continuation', url: 'u', fetchedAt: 'f' }
    })
    mockParseHistory.mockImplementation((payload: unknown) =>
      payload === 'continuation' ? [orderRow, olderRow] : [orderRow]
    )
    const marker = {
      detected_at: '2026-07-14T00:00:00Z',
      page_cap: 20,
      oldest_captured_at: '2026-07-15T11:00:00.000Z',
    }
    mockDbQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("meta->'history_truncated'->$2::text AS marker")
        ? { rows: [{ marker }], rowCount: 1 }
        : { rows: [], rowCount: 1 }
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
      parseHistory: mockParseHistory,
      validateProfile: mockValidateProfile,
      historyContinuation: () => ({ supported: true, mode: 'page_offset' }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 1, errors: 0 })

    expect(mockGetHistory).toHaveBeenCalledTimes(2)
    // Pre-#440 marker: forward run covered pages 1..20 → overlap page 20.
    expect(mockGetHistory.mock.calls[1][6]).toEqual({
      continuation: { mode: 'page_offset', startPage: 20 },
    })
    expect(mockGetHistory.mock.calls[1][4]).toBeNull()
    expect(mockPublishHistoryRows).toHaveBeenLastCalledWith(
      src,
      42,
      'orders',
      [orderRow, olderRow],
      null
    )
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes("meta - 'history_truncated'"))
    ).toBe(true)
  })

  it('does not continue in the same run whose forward pass was cut (bounded per run)', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistory.mockImplementation(async function* () {
      yield* orderHistoryStream()
      throw new HistoryPageCapReachedError('gtrade', 'orders', 25, 26)
    })
    mockParseHistory.mockReturnValue([orderRow])
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
      historyContinuation: () => ({ supported: true, mode: 'page_offset' }),
    })

    await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 1, errors: 0 })
    expect(mockGetHistory).toHaveBeenCalledTimes(1)
    const truncation = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes("'history_truncated'")
    )
    expect(JSON.parse(String(truncation?.[1]?.[4]))).toMatchObject({
      state: 'pending',
      mode: 'page_offset',
      resume_page: 26,
    })
  })

  it('still fails a history crawl on a non-cap fetch error', async () => {
    mockProfileTimeframes.mockReturnValue([30])
    mockParseProfile.mockReturnValue(profile(30, true))
    mockGetHistoryCursor.mockResolvedValue(null)
    mockGetHistory.mockImplementation(async function* () {
      yield* orderHistoryStream()
      throw new Error('upstream 500')
    })
    mockParseHistory.mockReturnValue([orderRow])
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

    await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 1 })
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
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
      tradersCrawled: 0,
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
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
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
      tradersCrawled: 0,
      historyRowsWritten: 0,
      errors: 1,
    })

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(tierBProfileMarkerCalls()).toHaveLength(0)
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
      crossCheckSkipped: 0,
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

  it('backs off a trader whose every failing timeframe is upstream 404/410', async () => {
    mockGetProfile.mockImplementation(async (_session, _source, _trader, timeframe) => {
      throw new UpstreamGoneError(timeframe === 7 ? 404 : 410, 'https://gtrade.test/profile')
    })

    await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 2 })
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(true)
  })

  it('keeps a trader retryable when any failure is not a 404/410', async () => {
    mockGetProfile.mockImplementation(async (_session, _source, _trader, timeframe) => {
      if (timeframe === 7) throw new UpstreamGoneError(404, 'https://gtrade.test/profile')
      throw new Error('upstream unavailable')
    })

    await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 2 })
    expect(
      mockDbQuery.mock.calls.some(([sql]) =>
        String(sql).includes('INSERT INTO arena.ingest_cursors')
      )
    ).toBe(false)
  })

  describe('bounded backoff for persistent non-404 failures', () => {
    function failuresAfterThisAttempt(failures: number) {
      mockDbQuery.mockImplementation(async (sql: string, params: unknown[]) =>
        String(sql).includes('RETURNING') && params?.[1] === 'tierb_failed_attempts'
          ? { rows: [{ failures }], rowCount: 1 }
          : { rows: [], rowCount: 1 }
      )
    }
    const clearCalls = () =>
      mockDbQuery.mock.calls.filter(
        ([sql, params]) =>
          String(sql).includes('meta - $2') && params?.[1] === 'tierb_failed_attempts'
      )

    it('keeps retrying below the attempt budget', async () => {
      failuresAfterThisAttempt(2)
      mockGetProfile.mockRejectedValue(new Error('[src] non-success API envelope (code=40001)'))

      await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 2 })
      expect(tierBProfileMarkerCalls()).toHaveLength(0)
    })

    it('backs off once the attempt budget is spent', async () => {
      failuresAfterThisAttempt(3)
      mockGetProfile.mockRejectedValue(new Error('[src] non-success API envelope (code=40001)'))

      await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 2 })
      expect(tierBProfileMarkerCalls()).toHaveLength(1)
      // The next refresh window starts with a fresh budget.
      expect(clearCalls()).toHaveLength(1)
    })

    it('also backs off when the profile succeeds but histories keep failing', async () => {
      failuresAfterThisAttempt(3)
      mockProfileTimeframes.mockReturnValue([30])
      mockParseProfile.mockReturnValue(profile(30, true))
      mockGetHistory.mockImplementation(() =>
        (async function* () {
          throw new Error('orders upstream failed')
        })()
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
        parseHistory: mockParseHistory,
        validateProfile: mockValidateProfile,
      })

      await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 1 })
      expect(tierBProfileMarkerCalls()).toHaveLength(1)
    })
  })

  it('counts an HTTP-200 business error (parse throw) toward the cycle failure rate', async () => {
    mockParseProfile.mockImplementation(() => {
      throw new Error('[src] profile returned a non-success API envelope (code=40001)')
    })

    await expect(processTierB(job)).resolves.toMatchObject({ tradersCrawled: 0, errors: 2 })
    expect(mockRecordParseFailure).toHaveBeenCalledTimes(2)
    expect(mockPublishProfile).not.toHaveBeenCalled()
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
