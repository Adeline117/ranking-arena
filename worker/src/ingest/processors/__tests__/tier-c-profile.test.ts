import type { Job } from 'bullmq'
import type { ParsedProfile, SourceRow } from '@/lib/ingest/core/types'
import type { TierCJobData } from '../../queues'

const mockRedisSet = jest.fn()
const mockGetSourceBySlug = jest.fn()
const mockGetAdapter = jest.fn()
const mockGetProfile = jest.fn()
const mockGetPositions = jest.fn()
const mockGetHistory = jest.fn()
const mockSelectCopierVerifier = jest.fn()
const mockVerifyCopierTerminal = jest.fn()
const mockVerifyCopierConservation = jest.fn()
const mockParseProfile = jest.fn()
const mockParseHistory = jest.fn()
const mockValidateProfile = jest.fn()
const mockOpenSession = jest.fn()
const mockSessionClose = jest.fn()
const mockWriteRawObject = jest.fn()
const mockWriteHistoryRawArtifact = jest.fn()
const mockWriteCopierPublicationLaneRawArtifact = jest.fn()
const mockRecordStagingRejects = jest.fn()
const mockPublishProfile = jest.fn()
const mockPublishPositions = jest.fn()
const mockPublishCopierSnapshot = jest.fn()
const mockPreflightCopierSnapshotV2Publication = jest.fn()
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
jest.mock('@/lib/ingest/fetch/fetcher', () => ({
  openSession: (...args: unknown[]) => mockOpenSession(...args),
}))
jest.mock('@/lib/ingest/raw', () => ({
  writeRawObject: (...args: unknown[]) => mockWriteRawObject(...args),
  writeHistoryRawArtifact: (...args: unknown[]) => mockWriteHistoryRawArtifact(...args),
}))
jest.mock('@/lib/ingest/copier-publication-lane-raw', () => ({
  writeCopierPublicationLaneRawArtifact: (...args: unknown[]) =>
    mockWriteCopierPublicationLaneRawArtifact(...args),
}))
jest.mock('@/lib/ingest/staging/rejects', () => ({
  recordStagingRejects: (...args: unknown[]) => mockRecordStagingRejects(...args),
}))
jest.mock('@/lib/ingest/serving/publish', () => ({
  preflightCopierSnapshotV2Publication: (...args: unknown[]) =>
    mockPreflightCopierSnapshotV2Publication(...args),
  publishCopierSnapshotV2: (...args: unknown[]) => mockPublishCopierSnapshot(...args),
  publishPositions: (...args: unknown[]) => mockPublishPositions(...args),
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
import {
  copierPublicationLaneSourceRunId,
  copierPublicationLaneStoragePath,
  type CopierPublicationLaneArtifact,
} from '@/lib/ingest/copier-publication-lane-artifact'

const src = {
  id: 34,
  slug: 'gtrade',
  adapter_slug: 'gtrade',
  currency: 'USDC',
  tf_label_map: {},
  meta: {},
  fetch_region: 'local',
  status: 'active',
  serving_mode: 'serving',
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

function historyJob(surface: 'position_history' | 'orders' | 'transfers' | 'copiers') {
  return {
    data: { ...job.data, surface },
  } as Job<TierCJobData>
}

async function* historyPreviewStream(options: { failAfterFirst?: boolean } = {}) {
  for (let pageIndex = 1; pageIndex <= 3; pageIndex += 1) {
    yield {
      pageIndex,
      payload: { pageIndex },
      url: `https://gtrade.test/history?page=${pageIndex}`,
      fetchedAt: new Date(Date.now() + pageIndex * 1_000).toISOString(),
    }
    if (options.failAfterFirst) throw new Error('history preview upstream failed')
  }
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [{ segment_id: 'default', reason: 'reported_end' as const, page_ordinal: 3 }],
  }
}

async function* historyWithoutResponsePages() {
  return {
    contract: 'arena.ingest.history-terminal-claim@1' as const,
    observations: [{ segment_id: 'default', reason: 'empty_page' as const, page_ordinal: 1 }],
  }
}

function parsedHistoryRow(kind: 'position_history' | 'orders' | 'transfers' | 'copiers') {
  const raw = { private: true }
  if (kind === 'position_history') {
    return {
      kind,
      openedAt: '2026-07-14T12:00:00.000Z',
      closedAt: '2026-07-15T12:00:00.000Z',
      symbol: 'BTCUSDT',
      side: 'long',
      leverage: 2,
      size: 1,
      entryPrice: 100,
      exitPrice: 110,
      realizedPnl: 10,
      dedupeHash: 'position-1',
      sourceFactId: '["trader","position-1"]',
      sourceLifecycleMarker: 'All Closed',
      sourceReturn: 0.1,
      fieldSources: {
        sourceFactId: { fieldPaths: ['data[].positionId'] },
        sourceLifecycleMarker: { fieldPaths: ['data[].status'] },
        sourceReturn: { fieldPaths: ['data[].roi'] },
      },
      limitations: [],
      raw,
    }
  }
  if (kind === 'orders') {
    return {
      kind,
      ts: '2026-07-15T12:00:00.000Z',
      orderKind: 'close',
      symbol: 'BTCUSDT',
      side: 'long',
      price: 110,
      qty: 1,
      dedupeHash: 'order-1',
      raw,
    }
  }
  if (kind === 'transfers') {
    return {
      kind,
      ts: '2026-07-15T12:00:00.000Z',
      direction: 'in' as const,
      asset: 'BTC',
      amount: 0.5,
      dedupeHash: 'transfer-1',
      raw,
    }
  }
  return {
    kind,
    ts: '2026-07-15T12:00:00.000Z',
    copierLabel: 'private-user@example.com',
    copierPnl: 10,
    copierInvested: 100,
    copyDurationDays: 3,
    dedupeHash: 'copier-1',
    raw,
  }
}

function expectedHistoryRenderRow(
  kind: 'position_history' | 'orders' | 'transfers' | 'copiers'
): Record<string, unknown> | null {
  const row = parsedHistoryRow(kind)
  if (row.kind === 'position_history') {
    return {
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
    }
  }
  if (row.kind === 'orders') {
    return {
      ts: row.ts,
      kind: row.orderKind,
      symbol: row.symbol,
      side: row.side,
      price: row.price,
      qty: row.qty,
      currency: 'USDC',
    }
  }
  if (row.kind === 'transfers') {
    return {
      ts: row.ts,
      direction: row.direction,
      asset: row.asset,
      amount: row.amount,
    }
  }
  return null
}

function historyAdapter(withCopierVerifier = false) {
  return {
    capabilities: {
      profile: true,
      positions: true,
      positionHistory: true,
      orders: true,
      transfers: true,
      copiers: true,
    },
    supportsSurface: () => true,
    getHistory: mockGetHistory,
    parseHistory: mockParseHistory,
    ...(withCopierVerifier
      ? {
          verifyCopierSnapshot: (...args: unknown[]) => mockSelectCopierVerifier(...args),
        }
      : {}),
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
    supportsSurface: () => true,
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
    mockWriteHistoryRawArtifact.mockImplementation(
      async (
        input: { sourceRunId: string },
        runTransaction: (
          operation: (transaction: { query: typeof mockIngestClientQuery }) => Promise<unknown>
        ) => Promise<unknown>
      ) =>
        runTransaction(async () => ({
          id: 2_081_897,
          storagePath: 'test/history/event_history.json.gz',
          contentHash: input.sourceRunId,
        }))
    )
    mockWriteCopierPublicationLaneRawArtifact.mockImplementation(
      async ({ artifact }: { artifact: CopierPublicationLaneArtifact }) => ({
        id: 2_081_898,
        storagePath: copierPublicationLaneStoragePath(artifact),
        contentHash: copierPublicationLaneSourceRunId(artifact),
      })
    )
    mockRecordStagingRejects.mockResolvedValue(undefined)
    mockValidateProfile.mockReturnValue([])
    mockRedisSet.mockResolvedValue('OK')
    mockPublishProfile.mockResolvedValue(undefined)
    mockPublishPositions.mockResolvedValue(undefined)
    mockSelectCopierVerifier.mockReturnValue({
      contract: 'arena.ingest.history-terminal-verifier.test.copiers@1',
      verifyTerminal: (...args: unknown[]) => mockVerifyCopierTerminal(...args),
      verifyConservation: (...args: unknown[]) => mockVerifyCopierConservation(...args),
    })
    mockVerifyCopierTerminal.mockReturnValue({
      verified: true,
      scanTerminalState: 'exhausted',
    })
    mockVerifyCopierConservation.mockImplementation((input: { rows: readonly unknown[] }) => ({
      verified: true,
      envelopeRowCount: input.rows.length,
    }))
    mockPublishCopierSnapshot.mockImplementation(
      async (request: {
        lane: 'tier_b' | 'tier_c'
        sourceRunId: string
        acquisitionSourceRunId: string
        observedAt: string
        rows: readonly unknown[]
      }) => ({
        receiptId: 501,
        lane: request.lane,
        sourceRunId: request.sourceRunId,
        acquisitionSourceRunId: request.acquisitionSourceRunId,
        observedAt: request.observedAt,
        publishedAt: '2026-07-15T12:00:01.000Z',
        rowCount: request.rows.length,
      })
    )
    mockIngestClientQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    mockIngestClientRelease.mockReturnValue(undefined)
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

  it('persists RAW but never clears positions for an empty acquisition bundle', async () => {
    mockGetAdapter.mockReturnValue({
      capabilities: { positions: true },
      supportsSurface: () => true,
      getPositions: mockGetPositions,
      parsePositions: jest.fn(),
    })
    mockGetPositions.mockResolvedValue({ ...bundle, pages: [] })
    const heavyJob = {
      data: { ...job.data, surface: 'positions' },
    } as Job<TierCJobData>

    await expect(processTierC(heavyJob, 'local')).rejects.toThrow(
      'snapshot has no captured source page'
    )

    expect(mockWriteRawObject).toHaveBeenCalledWith(
      expect.objectContaining({ jobType: 'tier_c', traderId: 42, payload: [] })
    )
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockPublishPositions).not.toHaveBeenCalled()
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('keeps position source freshness distinct from the capture clock', async () => {
    mockGetSourceBySlug.mockResolvedValue({
      ...src,
      meta: { positions_delay_hours: 1 },
    })
    mockGetAdapter.mockReturnValue(positionsAdapter())
    mockGetPositions.mockResolvedValue(bundle)

    await expect(
      processTierC({ data: { ...job.data, surface: 'positions' } } as Job<TierCJobData>, 'local')
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
    expect(mockPublishPositions).toHaveBeenCalledWith(
      expect.objectContaining({ slug: src.slug }),
      42,
      expect.any(Array),
      '2026-07-15T11:00:00.000Z',
      expect.any(Object)
    )

    const cacheCall = mockDbQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.profile_cache')
    )
    expect(JSON.parse(String(cacheCall?.[1]?.[4]))).toEqual(renderPayload)
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
    expect(renderPayload).not.toHaveProperty('asOf')
    expect(mockPublishPositions).toHaveBeenCalledWith(
      src,
      42,
      expect.any(Array),
      '2026-07-15T12:00:00.000Z',
      expect.any(Object)
    )
  })

  it.each(['position_history', 'orders', 'transfers'] as const)(
    'keeps the %s interactive result partial, private, and RAW-only',
    async (surface) => {
      mockGetAdapter.mockReturnValue(historyAdapter())
      mockGetHistory.mockImplementation(() => historyPreviewStream())
      mockParseHistory.mockImplementation((_payload: unknown, kind: typeof surface) => [
        parsedHistoryRow(kind),
      ])
      const expectedRow = expectedHistoryRenderRow(surface)
      const expectedRows = expectedRow === null ? [] : [expectedRow, expectedRow]

      await expect(processTierC(historyJob(surface), 'local')).resolves.toMatchObject({
        traderId: 42,
        surface,
        rows: expectedRows.length,
        completeness: {
          state: 'partial',
          reason: 'interactive_preview',
          evidenceState: 'caller_limited',
          scanTerminalState: 'partial',
          blockerReasons: ['caller_limit'],
        },
      })

      expect(mockGetHistory).toHaveBeenCalledWith(
        expect.anything(),
        src,
        job.data.exchangeTraderId,
        surface,
        null,
        null
      )
      expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
      expect(mockWriteHistoryRawArtifact).toHaveBeenCalledWith(
        {
          artifact: expect.objectContaining({
            source: { id: src.id, slug: src.slug },
            trader: { id: 42, exchange_trader_id: job.data.exchangeTraderId },
            history_kind: surface,
            starting_cursor: null,
            capture_config: { caller_page_cap: 2 },
            pages: [expect.any(Object), expect.any(Object)],
            termination: expect.objectContaining({
              evidence_state: 'caller_limited',
              scan_terminal_state: 'partial',
              blocker_reasons: ['caller_limit'],
            }),
          }),
          sourceRunId: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
        expect.any(Function)
      )
      expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
      expect(mockWriteRawObject).not.toHaveBeenCalled()
      expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
      expect(
        mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
      ).toBe(false)

      expect(mockRedisSet).toHaveBeenCalledWith('tier-c:result', expect.any(String), 'EX', 120)
      const renderPayload = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
      expect(renderPayload).toMatchObject({
        rows: expectedRows,
        nextCursor: null,
        sourceAsOf: null,
        observedAt: expect.any(String),
        publishedAt: null,
        completeness: {
          state: 'partial',
          reason: 'interactive_preview',
          evidenceState: 'caller_limited',
          scanTerminalState: 'partial',
          blockerReasons: ['caller_limit'],
        },
      })
      expect(renderPayload.rows).toEqual(expectedRows)
      if (surface === 'transfers') {
        expect(renderPayload.rows[0]).not.toHaveProperty('currency')
      }
      expect(renderPayload).not.toHaveProperty('asOf')
      expect(JSON.stringify(renderPayload.rows)).not.toContain('private-user@example.com')
      for (const row of renderPayload.rows) {
        expect(row.raw).toBeUndefined()
        expect(row.copierLabel).toBeUndefined()
        expect(row.copierPnl).toBeUndefined()
        expect(row.copierInvested).toBeUndefined()
        expect(row.sourceFactId).toBeUndefined()
        expect(row.sourceLifecycleMarker).toBeUndefined()
        expect(row.sourceReturn).toBeUndefined()
        expect(row.fieldSources).toBeUndefined()
        expect(row.limitations).toBeUndefined()
      }
      expect(mockSessionClose).toHaveBeenCalledTimes(1)
    }
  )

  it('commits verified RAW and its atomic copier receipt before an exact opaque marker', async () => {
    const copierRow = parsedHistoryRow('copiers')
    mockGetAdapter.mockReturnValue(historyAdapter(true))
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockReturnValue([copierRow])

    await expect(processTierC(historyJob('copiers'), 'local')).resolves.toEqual({
      traderId: 42,
      surface: 'copiers',
      aggregateReady: true,
    })

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierPublicationLaneRawArtifact).toHaveBeenCalledTimes(1)
    const wrapper = mockWriteCopierPublicationLaneRawArtifact.mock.calls[0][0]
      .artifact as CopierPublicationLaneArtifact
    expect(wrapper.publication_lane).toBe('tier_c')
    expect(wrapper.acquisition.capture_config).toEqual({ caller_page_cap: null })
    expect(wrapper.acquisition.pages).toHaveLength(3)
    expect(wrapper.acquisition.termination).toMatchObject({
      evidence_state: 'verified',
      scan_terminal_state: 'exhausted',
      blocker_reasons: [],
    })
    expect(mockVerifyCopierTerminal).toHaveBeenCalledTimes(1)
    expect(mockVerifyCopierConservation).toHaveBeenCalledWith({
      exchangeTraderId: job.data.exchangeTraderId,
      parserClock: wrapper.acquisition.attempt_started_at,
      pages: expect.any(Array),
      rows: [copierRow, copierRow, copierRow],
    })
    expect(mockPreflightCopierSnapshotV2Publication).toHaveBeenCalledWith({
      lane: 'tier_c',
      sourceId: src.id,
      traderId: 42,
      sourceRunId: copierPublicationLaneSourceRunId(wrapper),
      acquisitionSourceRunId: wrapper.acquisition_source_run_id,
      observedAt: wrapper.acquisition.pages[2].fetched_at,
      currency: 'USDC',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
      rows: [copierRow, copierRow, copierRow],
    })
    expect(mockPublishCopierSnapshot).toHaveBeenCalledWith({
      lane: 'tier_c',
      sourceId: src.id,
      traderId: 42,
      rawObject: {
        id: 2_081_898,
        storagePath: copierPublicationLaneStoragePath(wrapper),
        contentHash: copierPublicationLaneSourceRunId(wrapper),
      },
      sourceRunId: copierPublicationLaneSourceRunId(wrapper),
      acquisitionSourceRunId: wrapper.acquisition_source_run_id,
      observedAt: wrapper.acquisition.pages[2].fetched_at,
      currency: 'USDC',
      evidenceState: 'verified',
      scanTerminalState: 'exhausted',
      blockerReasons: [],
      rows: [copierRow, copierRow, copierRow],
    })
    expect(mockWriteHistoryRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      mockParseHistory.mock.invocationCallOrder[0]
    )
    expect(mockParseHistory.mock.invocationCallOrder[0]).toBeLessThan(
      mockVerifyCopierConservation.mock.invocationCallOrder[0]
    )
    expect(mockVerifyCopierConservation.mock.invocationCallOrder[0]).toBeLessThan(
      mockPreflightCopierSnapshotV2Publication.mock.invocationCallOrder[0]
    )
    expect(mockPreflightCopierSnapshotV2Publication.mock.invocationCallOrder[0]).toBeLessThan(
      mockWriteCopierPublicationLaneRawArtifact.mock.invocationCallOrder[0]
    )
    expect(mockWriteCopierPublicationLaneRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishCopierSnapshot.mock.invocationCallOrder[0]
    )
    expect(mockPublishCopierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedisSet.mock.invocationCallOrder[0]
    )

    expect(mockRedisSet).toHaveBeenCalledWith('tier-c:result', expect.any(String), 'EX', 120)
    const readyMarker = JSON.parse(String(mockRedisSet.mock.calls[0][1]))
    expect(readyMarker).toEqual({
      contract: 'arena.tier-c.copier-ready@1',
      completed: true,
      aggregateReady: true,
    })
    expect(JSON.stringify(readyMarker)).not.toMatch(
      /private-user@example\.com|copierPnl|copierInvested|copyDurationDays|rows|raw/i
    )
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('publishes no copier marker or public cache when the receipt RPC fails', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter(true))
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockReturnValue([parsedHistoryRow('copiers')])
    mockPublishCopierSnapshot.mockRejectedValue(new Error('copier receipt RPC failed'))

    await expect(processTierC(historyJob('copiers'), 'local')).rejects.toThrow(
      'copier receipt RPC failed'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierPublicationLaneRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockPublishCopierSnapshot).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierPublicationLaneRawArtifact.mock.invocationCallOrder[0]).toBeLessThan(
      mockPublishCopierSnapshot.mock.invocationCallOrder[0]
    )
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('publishes a verified zero-row receipt before marking the aggregate ready', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter(true))
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockReturnValue([])
    await expect(processTierC(historyJob('copiers'), 'local')).resolves.toEqual({
      traderId: 42,
      surface: 'copiers',
      aggregateReady: true,
    })

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierPublicationLaneRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockParseHistory).toHaveBeenCalledTimes(3)
    expect(mockVerifyCopierConservation).toHaveBeenCalledWith(expect.objectContaining({ rows: [] }))
    expect(mockPublishCopierSnapshot).toHaveBeenCalledWith(expect.objectContaining({ rows: [] }))
    expect(mockPublishCopierSnapshot.mock.invocationCallOrder[0]).toBeLessThan(
      mockRedisSet.mock.invocationCallOrder[0]
    )
    expect(JSON.parse(String(mockRedisSet.mock.calls[0][1]))).toEqual({
      contract: 'arena.tier-c.copier-ready@1',
      completed: true,
      aggregateReady: true,
    })
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
  })

  it.each([
    { label: 'empty', parsed: [] },
    { label: 'non-empty', parsed: [parsedHistoryRow('copiers')] },
  ])('fails an unverified $label copier snapshot closed after RAW', async ({ parsed }) => {
    mockGetAdapter.mockReturnValue(historyAdapter())
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockReturnValue(parsed)

    await expect(processTierC(historyJob('copiers'), 'local')).rejects.toThrow(
      'copier snapshot has no verified exhaustive terminal proof'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledWith(
      {
        artifact: expect.objectContaining({
          capture_config: { caller_page_cap: 2 },
          pages: [expect.any(Object), expect.any(Object)],
          termination: expect.objectContaining({
            evidence_state: 'caller_limited',
            scan_terminal_state: 'partial',
            blocker_reasons: ['caller_limit'],
          }),
        }),
        sourceRunId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      expect.any(Function)
    )
    expect(mockWriteCopierPublicationLaneRawArtifact).not.toHaveBeenCalled()
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockVerifyCopierConservation).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
  })

  it('fails closed when the copier terminal verifier rejects the claim', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter(true))
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockVerifyCopierTerminal.mockReturnValue({ verified: false })

    await expect(processTierC(historyJob('copiers'), 'local')).rejects.toThrow(
      'copier snapshot has no verified exhaustive terminal proof'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierPublicationLaneRawArtifact).not.toHaveBeenCalled()
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'explicit rejection',
      verification: { verified: false },
      message: 'copier snapshot conservation was not verified',
    },
    {
      label: 'row-count mismatch',
      verification: { verified: true, envelopeRowCount: 2 },
      message: 'copier snapshot envelope/parser conservation mismatch',
    },
    {
      label: 'extra verifier field',
      verification: { verified: true, envelopeRowCount: 3, extra: true },
      message: 'copier snapshot envelope/parser conservation mismatch',
    },
  ])('fails closed on $label', async ({ verification, message }) => {
    mockGetAdapter.mockReturnValue(historyAdapter(true))
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockReturnValue([parsedHistoryRow('copiers')])
    mockVerifyCopierConservation.mockReturnValue(verification)

    await expect(processTierC(historyJob('copiers'), 'local')).rejects.toThrow(message)

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteCopierPublicationLaneRawArtifact).not.toHaveBeenCalled()
    expect(mockParseHistory).toHaveBeenCalledTimes(3)
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('requires a copier response page before parsing or publishing readiness', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter(true))
    mockGetHistory.mockImplementation(() => historyWithoutResponsePages())

    await expect(processTierC(historyJob('copiers'), 'local')).rejects.toThrow(
      'copier snapshot returned no upstream response page'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledWith(
      {
        artifact: expect.objectContaining({
          history_kind: 'copiers',
          pages: [],
        }),
        sourceRunId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      expect.any(Function)
    )
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
  })

  it('persists a partial RAW artifact before failing an interrupted history preview', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter())
    mockGetHistory.mockImplementation(() => historyPreviewStream({ failAfterFirst: true }))

    await expect(processTierC(historyJob('position_history'), 'local')).rejects.toThrow(
      'history preview upstream failed'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledWith(
      {
        artifact: expect.objectContaining({
          history_kind: 'position_history',
          pages: [expect.any(Object)],
          termination: expect.objectContaining({
            evidence_state: 'upstream_error',
            scan_terminal_state: 'partial',
            blocker_reasons: ['upstream_error'],
          }),
        }),
        sourceRunId: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      expect.any(Function)
    )
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockParseHistory).not.toHaveBeenCalled()
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('commits the RAW pointer before parsing and exposes nothing when parsing fails', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter())
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockImplementation(() => {
      throw new Error('history parser failed')
    })

    await expect(processTierC(historyJob('orders'), 'local')).rejects.toThrow(
      'history parser failed'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockIngestClientQuery.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'COMMIT'])
    expect(mockIngestClientQuery.mock.invocationCallOrder[1]).toBeLessThan(
      mockParseHistory.mock.invocationCallOrder[0]
    )
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
    expect(
      mockDbQuery.mock.calls.some(([sql]) => String(sql).includes('arena.profile_cache'))
    ).toBe(false)
    expect(mockSessionClose).toHaveBeenCalledTimes(1)
  })

  it('rejects a parser row from another history surface after preserving RAW', async () => {
    mockGetAdapter.mockReturnValue(historyAdapter())
    mockGetHistory.mockImplementation(() => historyPreviewStream())
    mockParseHistory.mockReturnValue([parsedHistoryRow('orders')])

    await expect(processTierC(historyJob('position_history'), 'local')).rejects.toThrow(
      'history row kind does not match position_history'
    )

    expect(mockWriteHistoryRawArtifact).toHaveBeenCalledTimes(1)
    expect(mockRedisSet).not.toHaveBeenCalled()
    expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
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
      expect(mockWriteHistoryRawArtifact).not.toHaveBeenCalled()
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
      expect(mockWriteHistoryRawArtifact).not.toHaveBeenCalled()
      expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
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
      expect(mockWriteHistoryRawArtifact).not.toHaveBeenCalled()
      expect(mockPublishCopierSnapshot).not.toHaveBeenCalled()
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
