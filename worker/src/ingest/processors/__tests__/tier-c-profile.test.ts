import type { Job } from 'bullmq'
import type { ParsedHistoryRow, ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import type { TierCJobData } from '../../queues'

const mockRedisSet = jest.fn()
const mockGetSourceBySlug = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockGetPositions = jest.fn()
const mockGetHistory = jest.fn()
const mockParseProfile = jest.fn()
const mockParseHistory = jest.fn()
const mockValidateProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockWriteCopierSnapshotRawArtifact = jest.fn()
const mockWritePositionHistoryRawArtifact = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockPublishProfile = jest.fn()
const mockGetHistoryCursor = jest.fn()
const mockNextHistoryCursor = jest.fn()
const mockPublishHistoryRows = jest.fn()
const mockPublishCopierSnapshot = jest.fn()
const mockDbQuery = jest.fn()
const mockIngestClientQuery = jest.fn()
const mockIngestClientRelease = jest.fn()

jest.mock('../../../connection', () => ({
  getConnection: jest.fn(() => ({ set: (...args: unknown[]) => mockRedisSet(...args) })),
}))
jest.mock('@/lib/ingest/sources', () => ({
  getSourceBySlug: (...args: unknown[]) => mockGetSourceBySlug(...args),
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
  writeCopierSnapshotRawArtifact: (...args: unknown[]) =>
    mockWriteCopierSnapshotRawArtifact(...args),
  writePositionHistoryRawArtifact: (...args: unknown[]) =>
    mockWritePositionHistoryRawArtifact(...args),
}))
jest.mock('@/lib/ingest/serving/copier-snapshot-publish', () => ({
  publishCopierSnapshotInTransaction: (...args: unknown[]) => mockPublishCopierSnapshot(...args),
}))
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  getHistoryCursor: (...args: unknown[]) => mockGetHistoryCursor(...args),
  publishHistoryRows: (...args: unknown[]) => mockPublishHistoryRows(...args),
  publishPositions: jest.fn(),
  publishProfile: (...args: unknown[]) => mockPublishProfile(...args),
}))
jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: (...args: unknown[]) => mockDbQuery(...args) })),
  ingestClientConnect: jest.fn(async () => ({
    query: (...args: unknown[]) => mockIngestClientQuery(...args),
    release: (...args: unknown[]) => mockIngestClientRelease(...args),
  })),
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
  copier_table_depth: 'full',
  serving_mode: 'serving',
  status: 'active',
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

const positionHistoryJob = {
  data: {
    ...job.data,
    surface: 'position_history',
  },
} as Job<TierCJobData>

const ordersJob = {
  data: {
    ...job.data,
    surface: 'orders',
  },
} as Job<TierCJobData>

const transfersJob = {
  data: {
    ...job.data,
    surface: 'transfers',
  },
} as Job<TierCJobData>

const copiersJob = {
  data: {
    ...job.data,
    surface: 'copiers',
  },
} as Job<TierCJobData>

function positionRow(id: number): Extract<ParsedHistoryRow, { kind: 'position_history' }> {
  return {
    kind: 'position_history',
    openedAt: `2026-07-${String(id).padStart(2, '0')}T10:00:00.000Z`,
    closedAt: `2026-07-${String(id).padStart(2, '0')}T11:00:00.000Z`,
    symbol: 'BTCUSDT',
    side: 'long',
    leverage: 2,
    size: 1,
    entryPrice: 100,
    exitPrice: 110,
    realizedPnl: 10,
    dedupeHash: `position-${id}`,
    raw: { id },
  }
}

const orderRow: Extract<ParsedHistoryRow, { kind: 'orders' }> = {
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

const transferRow: Extract<ParsedHistoryRow, { kind: 'transfers' }> = {
  kind: 'transfers',
  ts: '2026-07-15T10:00:00.000Z',
  direction: 'in',
  asset: 'BTC',
  amount: 0.5,
  dedupeHash: 'transfer-1',
  raw: { id: 'transfer-1' },
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

function positionHistoryStream(
  pageCount: number,
  options: { failAfterPage?: boolean; state?: { pulled: number; closed: boolean } } = {}
) {
  return (async function* () {
    try {
      for (let pageIndex = 1; pageIndex <= pageCount; pageIndex += 1) {
        if (options.state) options.state.pulled += 1
        yield {
          pageIndex,
          payload: { id: pageIndex },
          url: `https://gtrade.test/history?page=${pageIndex}`,
          fetchedAt: new Date(Date.now() + pageIndex * 1_000).toISOString(),
        }
        if (options.failAfterPage) throw new Error('history upstream failed')
      }
      return {
        contract: 'arena.ingest.history-terminal-claim@1' as const,
        observations: [
          { segment_id: 'default', reason: 'reported_end' as const, page_ordinal: pageCount },
        ],
      }
    } finally {
      if (options.state) options.state.closed = true
    }
  })()
}

function positionHistoryAdapter(withVerifier = true) {
  return {
    capabilities: {
      profile: true,
      positions: true,
      positionHistory: true,
      orders: false,
      transfers: false,
      copiers: false,
    },
    getHistory: mockGetHistory,
    parseHistory: mockParseHistory,
    ...(withVerifier
      ? {
          historyTerminalVerifier: () => ({
            contract: 'arena.ingest.history-terminal-verifier.test.position_history@1',
            verify: () => ({ verified: true, scanTerminalState: 'exhausted' }),
          }),
        }
      : {}),
  }
}

function ordersAdapter() {
  return {
    capabilities: {
      profile: true,
      positions: true,
      positionHistory: false,
      orders: true,
      transfers: false,
      copiers: false,
    },
    getHistory: mockGetHistory,
    parseHistory: mockParseHistory,
  }
}

function transfersAdapter() {
  return {
    capabilities: {
      profile: true,
      positions: true,
      positionHistory: false,
      orders: false,
      transfers: true,
      copiers: false,
    },
    getHistory: mockGetHistory,
    parseHistory: mockParseHistory,
  }
}

function copiersAdapter() {
  return {
    capabilities: {
      profile: true,
      positions: true,
      positionHistory: false,
      orders: false,
      transfers: false,
      copiers: true,
    },
    getHistory: mockGetHistory,
    parseHistory: mockParseHistory,
  }
}

function positionsAdapter() {
  return {
    capabilities: {
      profile: true,
      positions: true,
      positionHistory: false,
      orders: false,
      transfers: false,
      copiers: false,
    },
    getPositions: mockGetPositions,
    parsePositions: jest.fn(() => [
      {
        symbol: 'BTCUSDT',
        side: 'long',
        leverage: 2,
        size: 1,
        entryPrice: 100,
        markPrice: 110,
        unrealizedPnl: 10,
        raw: {},
      },
    ]),
  }
}

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
    mockWriteRawObject.mockResolvedValue({
      id: 2_081_896,
      storagePath: 'test/tier_c/raw.json.gz',
      contentHash: 'a'.repeat(64),
    })
    mockWriteCopierSnapshotRawArtifact.mockResolvedValue({
      id: 2_081_898,
      storagePath: 'gtrade/copier_snapshot/tier_c/test.json.gz',
      contentHash: 'c'.repeat(64),
    })
    mockWritePositionHistoryRawArtifact.mockImplementation(
      async (
        _input: unknown,
        runTransaction: (operation: (transaction: unknown) => Promise<unknown>) => Promise<unknown>
      ) =>
        runTransaction(async () => ({
          id: 2_081_897,
          storagePath: 'test/history/event.json.gz',
          contentHash: 'b'.repeat(64),
        }))
    )
    mockRecordStagingRejects.mockResolvedValue(undefined)
    mockValidateProfile.mockReturnValue([])
    mockRedisSet.mockResolvedValue('OK')
    mockPublishProfile.mockResolvedValue(undefined)
    mockSessionClose.mockResolvedValue(undefined)
    mockGetHistoryCursor.mockResolvedValue('2026-07-01T00:00:00.000Z')
    mockNextHistoryCursor.mockReturnValue('2026-07-15T11:00:00.000Z')
    mockPublishHistoryRows.mockResolvedValue(1)
    mockPublishCopierSnapshot.mockResolvedValue({
      publicationId: 3_001,
      publishedAt: '2026-07-15T12:00:01.000Z',
      parsedRowCount: 1,
      replayed: false,
    })
    mockIngestClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockIngestClientRelease.mockReturnValue(undefined)
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
    expect(mockPublishProfile).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('captures exactly two position-history pages as caller-limited preview evidence', async () => {
    const state = { pulled: 0, closed: false }
    mockGetAdapter.mockReturnValue(positionHistoryAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(3, { state }))
    mockParseHistory.mockImplementation((payload: { id: number }) => [positionRow(payload.id)])

    await expect(processTierC(positionHistoryJob, 'local')).resolves.toMatchObject({
      traderId: 42,
      surface: 'position_history',
      rows: 2,
    })

    expect(state).toEqual({ pulled: 2, closed: true })
    expect(mockWriteRawObject).not.toHaveBeenCalled()
    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      sourceRunId: expect.stringMatching(/^[0-9a-f]{64}$/),
      artifact: {
        capture_config: { caller_page_cap: 2 },
        pages: [expect.any(Object), expect.any(Object)],
        termination: {
          evidence_state: 'caller_limited',
          scan_terminal_state: 'partial',
          blocker_reasons: ['caller_limit'],
        },
      },
    })
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetHistory.mock.calls[0]?.[4]).toBeNull()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload.rows).toEqual(
      [positionRow(1), positionRow(2)].map((row) => ({
        symbol: row.symbol,
        side: row.side,
        leverage: row.leverage,
        size: row.size,
        entry_price: row.entryPrice,
        exit_price: row.exitPrice,
        realized_pnl: row.realizedPnl,
        opened_at: row.openedAt,
        closed_at: row.closedAt,
        currency: 'USDC',
      }))
    )
    expect(renderPayload.nextCursor).toBeNull()
    expect(renderPayload).toMatchObject({
      sourceAsOf: null,
      observedAt: mockWritePositionHistoryRawArtifact.mock.calls[0][0].artifact.pages[1].fetched_at,
      publishedAt: null,
    })
    expect(renderPayload).not.toHaveProperty('asOf')
    expect(renderPayload.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
      evidenceState: 'caller_limited',
      scanTerminalState: 'partial',
      blockerReasons: ['caller_limit'],
    })
    const cacheCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('arena.profile_cache')
    )
    expect(JSON.parse(String(cacheCall?.[1]?.[4])).completeness).toEqual(renderPayload.completeness)
    expect(JSON.parse(String(cacheCall?.[1]?.[4])).observedAt).toBe(renderPayload.observedAt)
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('never advances the Tier-C cursor even when one page has verified exhaustion', async () => {
    mockGetAdapter.mockReturnValue(positionHistoryAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockReturnValue([positionRow(1)])

    await expect(processTierC(positionHistoryJob, 'local')).resolves.toMatchObject({
      traderId: 42,
      surface: 'position_history',
      rows: 1,
    })

    expect(mockWritePositionHistoryRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        capture_config: { caller_page_cap: 2 },
        termination: {
          evidence_state: 'verified',
          scan_terminal_state: 'exhausted',
        },
      },
    })
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockGetHistory.mock.calls[0]?.[4]).toBeNull()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload).toMatchObject({
      sourceAsOf: null,
      observedAt: mockWritePositionHistoryRawArtifact.mock.calls[0][0].artifact.pages[0].fetched_at,
      publishedAt: null,
    })
    expect(renderPayload.completeness).toEqual({
      state: 'partial',
      reason: 'interactive_preview',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
    })
  })

  it('persists upstream-error position-history RAW without rendering or publishing rows', async () => {
    mockGetAdapter.mockReturnValue(positionHistoryAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1, { failAfterPage: true }))

    await expect(processTierC(positionHistoryJob, 'local')).rejects.toThrow(
      'history upstream failed'
    )

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
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
  })

  it('commits the audit-only RAW pointer before Tier-C history parsing', async () => {
    mockGetAdapter.mockReturnValue(positionHistoryAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockImplementation(() => {
      throw new Error('position parser rejected the page')
    })

    await expect(processTierC(positionHistoryJob, 'local')).rejects.toThrow(
      'position parser rejected the page'
    )

    expect(mockWritePositionHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
  })

  it('keeps non-position Tier-C history on the compatibility publisher', async () => {
    mockGetAdapter.mockReturnValue(ordersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockReturnValue([orderRow])

    await expect(processTierC(ordersJob, 'local')).resolves.toMatchObject({
      traderId: 42,
      surface: 'orders',
      rows: 1,
    })

    expect(mockGetHistoryCursor).toHaveBeenCalledWith(42, 'orders')
    expect(mockGetHistory.mock.calls[0]?.[4]).toBe('2026-07-01T00:00:00.000Z')
    expect(mockWriteRawObject).toHaveBeenCalledTimes(1)
    expect(mockWritePositionHistoryRawArtifact).not.toHaveBeenCalled()
    expect(mockPublishHistoryRows).toHaveBeenCalledWith(
      src,
      42,
      'orders',
      [orderRow],
      '2026-07-15T11:00:00.000Z'
    )
    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload.rows).toEqual([
      {
        ts: orderRow.ts,
        kind: orderRow.orderKind,
        symbol: orderRow.symbol,
        side: orderRow.side,
        price: orderRow.price,
        qty: orderRow.qty,
        currency: 'USDC',
      },
    ])
    expect(renderPayload.rows[0]).not.toHaveProperty('orderKind')
    expect(renderPayload.rows[0]).not.toHaveProperty('dedupeHash')
    expect(renderPayload.rows[0]).not.toHaveProperty('raw')
  })

  it('renders transfer parser rows with the warm RPC field contract', async () => {
    mockGetAdapter.mockReturnValue(transfersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockReturnValue([transferRow])

    await expect(processTierC(transfersJob, 'local')).resolves.toMatchObject({
      traderId: 42,
      surface: 'transfers',
      rows: 1,
    })

    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload.rows).toEqual([
      {
        ts: transferRow.ts,
        direction: transferRow.direction,
        asset: transferRow.asset,
        amount: transferRow.amount,
      },
    ])
    expect(renderPayload.rows[0]).not.toHaveProperty('dedupeHash')
    expect(renderPayload.rows[0]).not.toHaveProperty('raw')
  })

  it('commits private copier rows before publishing an exact opaque ready marker', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockReturnValue([copierRow])

    await expect(processTierC(copiersJob, 'local')).resolves.toMatchObject({
      traderId: 42,
      surface: 'copiers',
      snapshotReady: true,
    })

    expect(mockWriteRawObject).not.toHaveBeenCalled()
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
          exchange_trader_id: job.data.exchangeTraderId,
        },
        lane: 'tier_c',
        request_timeframe: 30,
        observed_at: expect.any(String),
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
          storagePath: 'gtrade/copier_snapshot/tier_c/test.json.gz',
          contentHash: 'c'.repeat(64),
        },
        rows: [copierRow],
      }
    )
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockGetHistoryCursor).not.toHaveBeenCalled()
    expect(mockNextHistoryCursor).not.toHaveBeenCalled()
    const readyMarker = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(readyMarker).toEqual({
      contract: 'arena.tier-c.copier-snapshot-ready@1',
      completed: true,
      snapshotReady: true,
    })
    expect(mockPublishCopierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedisSet.mock.invocationCallOrder[0]
    )
    expect(mockWriteCopierSnapshotRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishCopierSnapshot.mock.invocationCallOrder[0]
    )
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(JSON.stringify(readyMarker)).not.toMatch(
      /private-user@example\.com|private-1|copierPnl|copierInvested|rows|raw/i
    )
  })

  it('publishes no copier marker or public cache when the private commit fails', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockReturnValue([copierRow])
    mockPublishCopierSnapshot.mockRejectedValue(new Error('private copier commit failed'))

    await expect(processTierC(copiersJob, 'local')).rejects.toThrow('private copier commit failed')

    expect(mockWriteCopierSnapshotRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockPublishCopierSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublishHistoryRows).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('publishes no copier receipt or marker when canonical RAW persistence fails', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockWriteCopierSnapshotRawArtifact.mockRejectedValue(new Error('copier RAW persistence failed'))

    await expect(processTierC(copiersJob, 'local')).rejects.toThrow('copier RAW persistence failed')

    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('keeps an upstream-error copier capture diagnostic-only', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1, { failAfterPage: true }))

    await expect(processTierC(copiersJob, 'local')).rejects.toThrow('history upstream failed')

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: [expect.any(Object)],
        meta: expect.objectContaining({ surface: 'copiers', fetch_failed: true }),
      })
    )
    expect(mockWriteCopierSnapshotRawArtifact).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('keeps canonical copier RAW durable when parsing rejects the snapshot', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(1))
    mockParseHistory.mockImplementation(() => {
      throw new Error('copier parser rejected the page')
    })

    await expect(processTierC(copiersJob, 'local')).rejects.toThrow(
      'copier parser rejected the page'
    )

    expect(mockWriteCopierSnapshotRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('keeps a zero-page copier capture diagnostic-only with no ready marker', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    mockGetHistory.mockImplementation(() => positionHistoryStream(0))

    await expect(processTierC(copiersJob, 'local')).rejects.toThrow(
      'copier capture returned no evidence page'
    )

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: 'tier_c',
        traderId: 42,
        payload: [],
        meta: expect.objectContaining({
          surface: 'copiers',
          fetch_failed: false,
          capture_rejected: 'no_evidence_page',
        }),
      })
    )
    expect(mockWriteCopierSnapshotRawArtifact).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('marks a two-page copier preview caller-limited without probing a third page', async () => {
    mockGetAdapter.mockReturnValue(copiersAdapter())
    const state = { pulled: 0, closed: false }
    mockGetHistory.mockImplementation(() => positionHistoryStream(3, { state }))
    mockParseHistory.mockReturnValue([copierRow])

    await expect(processTierC(copiersJob, 'local')).resolves.toMatchObject({
      snapshotReady: true,
    })

    expect(state).toEqual({ pulled: 2, closed: true })
    expect(mockWriteCopierSnapshotRawArtifact.mock.calls[0][0]).toMatchObject({
      artifact: {
        page_count: 2,
        caller_limited: true,
        scan_terminal_state: 'caller_limited',
      },
    })
  })

  it('keeps position source freshness distinct from the capture clock', async () => {
    mockGetSourceBySlug.mockResolvedValue({
      ...src,
      meta: { positions_delay_hours: 1 },
    })
    mockGetAdapter.mockReturnValue(positionsAdapter())
    mockGetPositions.mockResolvedValue(bundle)

    await expect(
      processTierC(
        {
          data: { ...job.data, surface: 'positions' },
        } as Job<TierCJobData>,
        'local'
      )
    ).resolves.toMatchObject({ traderId: 42, surface: 'positions', rows: 1 })

    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload).toMatchObject({
      sourceAsOf: '2026-07-15T11:00:00.000Z',
      observedAt: '2026-07-15T12:00:00.000Z',
      publishedAt: null,
    })
    expect(renderPayload.rows).toEqual([
      {
        symbol: 'BTCUSDT',
        side: 'long',
        leverage: 2,
        size: 1,
        entry_price: 100,
        mark_price: 110,
        unrealized_pnl: 10,
        currency: 'USDC',
      },
    ])
    expect(renderPayload.rows[0]).not.toHaveProperty('entryPrice')
    expect(renderPayload.rows[0]).not.toHaveProperty('raw')
    expect(renderPayload).not.toHaveProperty('asOf')
  })

  it('does not infer position source freshness without an explicit delay contract', async () => {
    mockGetAdapter.mockReturnValue(positionsAdapter())
    mockGetPositions.mockResolvedValue(bundle)

    await processTierC(
      { data: { ...job.data, surface: 'positions' } } as Job<TierCJobData>,
      'local'
    )

    const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(renderPayload).toMatchObject({
      sourceAsOf: null,
      observedAt: '2026-07-15T12:00:00.000Z',
      publishedAt: null,
    })
  })

  it('fails closed when a position capture has no evidence page', async () => {
    const adapter = positionsAdapter()
    mockGetAdapter.mockReturnValue(adapter)
    mockGetPositions.mockResolvedValue({ ...bundle, pages: [] })

    await expect(
      processTierC({ data: { ...job.data, surface: 'positions' } } as Job<TierCJobData>, 'local')
    ).rejects.toThrow('positions capture returned no evidence page')

    expect(adapter.parsePositions).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
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

  it.each([
    { status: 'inactive' as const, serving_mode: 'serving' as const },
    { status: 'active' as const, serving_mode: 'shadow' as const },
    { status: 'dropped' as const, serving_mode: 'legacy' as const },
  ])(
    'rejects a non-serving source before subject lookup or network I/O: $status/$serving_mode',
    async ({ status, serving_mode }) => {
      mockGetSourceBySlug.mockResolvedValue({ ...src, status, serving_mode })

      await expect(processTierC(job, 'local')).rejects.toThrow('is not active serving')

      expect(mockDbQuery).not.toHaveBeenCalled()
      expect(mockGetAdapter).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockWriteRawObject).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
    }
  )

  it.each(['profile', 'copiers'] as const)(
    'rejects a nonexistent %s subject without creating a trader or opening the network',
    async (surface) => {
      mockDbQuery.mockResolvedValue({ rows: [], rowCount: 0 })

      await expect(
        processTierC({ data: { ...job.data, surface } } as Job<TierCJobData>, 'local')
      ).rejects.toThrow('trader is not an existing serving subject')

      expect(mockDbQuery).toHaveBeenCalledTimes(1)
      expect(String(mockDbQuery.mock.calls[0][0])).toContain('SELECT t.id, t.meta')
      expect(mockGetAdapter).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockWriteRawObject).not.toHaveBeenCalled()
      expect(mockPublishHistoryRows).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
    }
  )

  it.each(['profile', 'copiers'] as const)(
    'never lets public Tier-C overwrite a claimed trader %s surface',
    async (surface) => {
      const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      mockDbQuery.mockResolvedValue({ rows: [{ id: 42, meta: { claimed: true } }], rowCount: 1 })

      await expect(
        processTierC({ data: { ...job.data, surface } } as Job<TierCJobData>, 'local')
      ).resolves.toEqual({ surfacesFetched: 0, skipped: 'claimed' })

      expect(warning).toHaveBeenCalledWith(expect.stringContaining('skip claimed trader'))
      warning.mockRestore()
      expect(mockGetAdapter).not.toHaveBeenCalled()
      expect(mockOpenSession).not.toHaveBeenCalled()
      expect(mockWriteRawObject).not.toHaveBeenCalled()
      expect(mockPublishHistoryRows).not.toHaveBeenCalled()
      expect(mockRedisSet).not.toHaveBeenCalled()
    }
  )

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
