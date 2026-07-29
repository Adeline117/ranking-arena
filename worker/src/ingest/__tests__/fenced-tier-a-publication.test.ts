import type { BoardSeriesBlock, ParsedLeaderboardRow, SourceRow } from '@/lib/ingest/core/types'
import type {
  PreparedBoardSeriesPublication,
  PublishBoardSeriesOptions,
  PublishSnapshotInput,
  PublishTrustedSnapshotInput,
} from '@/lib/ingest/serving/publish'
import type {
  LeaderboardAttemptBoundV4Bundle,
  PreparedLeaderboardAttemptBoundV4Evidence,
} from '@/lib/ingest/serving/metric-trust-publish'

import type { AuthorizedConsumedRegionContext } from '../consumed-region-context'
import type { RegionAuthorityFence } from '../region-authority-lifecycle'
import type { WorkerDbFencedWrite } from '../worker-db-fence'
import { validateWorkerDbFencedWriteStatement } from '../worker-db-fence'

const mockPublishSnapshot = jest.fn()
const mockPublishTrustedSnapshot = jest.fn()
const mockPrepareBoardSeries = jest.fn()
const mockPublishBoardSeries = jest.fn()
const mockPublicationWrite = jest.fn()
const mockPrepareAttemptEvidence = jest.fn()
const mockFenceAttemptEvidence = jest.fn()
const mockSnapshotTrustValue = jest.fn((value: unknown) => value)

jest.mock('@/lib/ingest/serving/publish', () => ({
  prepareBoardSeriesPublication: (...args: unknown[]) => mockPrepareBoardSeries(...args),
  publishBoardSeriesInTransaction: (...args: unknown[]) => mockPublishBoardSeries(...args),
  publishLeaderboardSnapshotInTransaction: (...args: unknown[]) => mockPublishSnapshot(...args),
  publishTrustedLeaderboardSnapshotInTransaction: (...args: unknown[]) =>
    mockPublishTrustedSnapshot(...args),
}))

jest.mock('@/lib/ingest/serving/metric-trust-publish', () => ({
  fenceAttemptBoundLeaderboardEvidencePublicationCommit: (...args: unknown[]) =>
    mockFenceAttemptEvidence(...args),
  prepareLeaderboardAttemptBoundV4Evidence: (...args: unknown[]) =>
    mockPrepareAttemptEvidence(...args),
  snapshotLeaderboardTrustValue: (value: unknown) => mockSnapshotTrustValue(value),
}))

import {
  publishFencedBoardSeries,
  publishFencedAttemptBoundLeaderboardSnapshot,
  publishFencedLeaderboardSnapshot,
  publishFencedTrustedLeaderboardSnapshot,
  type PublishAttemptBoundLeaderboardSnapshotInput,
} from '../fenced-tier-a-publication'

const src = {
  adapter_slug: 'xt',
  exchange_id: 8,
  id: 19,
  slug: 'xt_futures',
  currency: 'USDT',
  fetch_region: 'local',
  page_size: 100,
  pagination_kind: 'numeric',
  product_type: 'futures',
  serving_mode: 'serving',
  status: 'active',
  timeframes_derived: [],
  timeframes_native: [7, 30, 90],
  trader_kind_scope: 'human',
} as SourceRow

interface LiveSourceRow {
  adapter_slug: string
  exchange_id: number
  fetch_region: string
  id: number
  page_size: number | null
  pagination_kind: string | null
  product_type: string
  serving_mode: string
  slug: string
  status: string
  timeframes_derived: number[]
  timeframes_native: number[]
  trader_kind_scope: string
}

function liveSourceRow(overrides: Partial<LiveSourceRow> = {}): LiveSourceRow {
  return {
    adapter_slug: src.adapter_slug,
    exchange_id: src.exchange_id,
    fetch_region: src.fetch_region,
    id: src.id,
    page_size: src.page_size,
    pagination_kind: src.pagination_kind,
    product_type: src.product_type,
    serving_mode: src.serving_mode,
    slug: src.slug,
    status: src.status,
    timeframes_derived: [...src.timeframes_derived],
    timeframes_native: [...src.timeframes_native],
    trader_kind_scope: src.trader_kind_scope,
    ...overrides,
  }
}

function leaderboardRow(overrides: Partial<ParsedLeaderboardRow> = {}): ParsedLeaderboardRow {
  return {
    avatarUrlOrigin: null,
    botStrategy: null,
    exchangeTraderId: 'trader-1',
    headlinePnl: 42,
    headlineRoi: 12,
    headlineWinRate: 60,
    nickname: 'Trader One',
    rank: 1,
    raw: {},
    traderKind: 'human',
    walletAddress: null,
    ...overrides,
  }
}

const boardSeries = new Map<string, BoardSeriesBlock[]>([
  [
    'trader-1',
    [
      {
        timeframe: 30,
        metric: 'pnl',
        points: [{ ts: '2026-07-28T10:00:00.000Z', value: 42 }],
      },
    ],
  ],
])
const boardTraderIds = new Map([['trader-1', 501]])
const boardOptions: PublishBoardSeriesOptions = {
  expectedLatestSnapshots: new Map([
    [
      30,
      {
        id: 77,
        rawObjectId: 9001,
        scrapedAt: '2026-07-28T10:00:00.000Z',
      },
    ],
  ]),
}

function boardPlan(
  overrides: Partial<PreparedBoardSeriesPublication> = {}
): PreparedBoardSeriesPublication {
  return {
    derivedRiskRows: [],
    expectedLatestSnapshots: [
      {
        timeframe: 30,
        id: 77,
        rawObjectId: 9001,
        scrapedAt: '2026-07-28T10:00:00.000Z',
      },
    ],
    replacements: [],
    rows: [
      {
        trader_id: 501,
        timeframe: 30,
        metric: 'pnl',
        ts: '2026-07-28T10:00:00.000Z',
        value: 42,
      },
    ],
    snapshotMemberships: [
      {
        exchange_trader_id: 'trader-1',
        trader_id: 501,
        timeframe: 30,
        snapshot_id: 77,
        raw_object_id: 9001,
      },
    ],
    source: {
      currency: 'USDT',
      fetch_region: 'local',
      id: src.id,
      slug: src.slug,
    },
    traders: 1,
    ...overrides,
  }
}

function boardPlanForTimeframes(
  timeframes: readonly (7 | 30 | 90)[]
): PreparedBoardSeriesPublication {
  return boardPlan({
    expectedLatestSnapshots: timeframes.map((timeframe, index) => ({
      timeframe,
      id: 77 + index,
      rawObjectId: 9001 + index,
      scrapedAt: '2026-07-28T10:00:00.000Z',
    })),
    rows: timeframes.map((timeframe) => ({
      trader_id: 501,
      timeframe,
      metric: 'pnl',
      ts: '2026-07-28T10:00:00.000Z',
      value: 42,
    })),
    snapshotMemberships: timeframes.map((timeframe, index) => ({
      exchange_trader_id: 'trader-1',
      trader_id: 501,
      timeframe,
      snapshot_id: 77 + index,
      raw_object_id: 9001 + index,
    })),
  })
}

function snapshotInput(overrides: Partial<PublishSnapshotInput> = {}): PublishSnapshotInput {
  return {
    src,
    timeframe: 30,
    rows: [],
    rejects: [],
    rawObjectId: 9001,
    ...overrides,
  }
}

function trustedInput(
  overrides: Partial<PublishTrustedSnapshotInput> = {}
): PublishTrustedSnapshotInput {
  return {
    src,
    timeframe: 30,
    rows: [],
    rejects: [],
    trust: {} as never,
    ...overrides,
  }
}

function preparedAttemptEvidence(): PreparedLeaderboardAttemptBoundV4Evidence {
  return {
    src,
    timeframe: 30,
    rows: [],
    manifest: {
      data_contract: 'arena.ingest.leaderboard-acquisition-manifest@4',
      observation_cycle_id: 'tier-a:bitget_bots_futures:job-1:1785232800000',
    },
    sourceRunId: 'a'.repeat(64),
    artifacts: {
      sourcePayload: {
        id: 201,
        storagePath: 'bitget_bots_futures/tier_a/source.json.gz',
        contentHash: 'b'.repeat(64),
      },
      populationManifest: {
        id: 202,
        storagePath: 'bitget_bots_futures/tier_a/manifest.json.gz',
        contentHash: 'a'.repeat(64),
      },
    },
  } as PreparedLeaderboardAttemptBoundV4Evidence
}

function attemptBoundInput(
  overrides: Partial<PublishAttemptBoundLeaderboardSnapshotInput> = {}
): PublishAttemptBoundLeaderboardSnapshotInput {
  return {
    src,
    timeframe: 30,
    rows: [],
    rejects: [],
    observationCycleId: 'tier-a:bitget_bots_futures:job-1:1785232800000',
    attemptEvidence: {} as LeaderboardAttemptBoundV4Bundle,
    ...overrides,
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function harness(options?: {
  active?: boolean
  authorityRegion?: 'local' | 'vps_sg'
  authorityScope?: string
  commitBarrier?: Promise<void>
  liveTraderRows?: unknown[]
  liveRows?: unknown[]
  rowCount?: number | null
  traderRowCount?: number | null
  snapshotBindingRowCount?: number | null
  onCommit?: jest.Mock
}) {
  const query = jest.fn(async (text: string) => {
    validateWorkerDbFencedWriteStatement(text)
    if (text.includes('FROM arena.sources AS source')) {
      return {
        rows: options?.liveRows ?? [liveSourceRow()],
        rowCount: options?.rowCount === undefined ? 1 : options.rowCount,
      }
    }
    if (text.includes('FROM arena.traders AS trader')) {
      const rows = options?.liveTraderRows ?? []
      return {
        rows,
        rowCount: options?.traderRowCount === undefined ? rows.length : options.traderRowCount,
      }
    }
    if (text.includes('UPDATE arena.leaderboard_snapshots')) {
      return {
        rows: [],
        rowCount:
          options?.snapshotBindingRowCount === undefined ? 1 : options.snapshotBindingRowCount,
      }
    }
    throw new Error(`unexpected fenced publication query: ${text}`)
  })
  const transaction = Object.freeze({
    query,
    signal: new AbortController().signal,
  }) as WorkerDbFencedWrite
  const withFencedWrite = jest.fn(
    async <T>(callback: (candidate: WorkerDbFencedWrite) => Promise<T>): Promise<T> => {
      const result = await callback(transaction)
      if (options?.commitBarrier !== undefined) await options.commitBarrier
      options?.onCommit?.()
      return result
    }
  )
  const authority = {
    isActive: jest.fn(() => options?.active ?? true),
    proof: {
      authorityScope: options?.authorityScope ?? 'region:local',
      region: options?.authorityRegion ?? 'local',
    },
    signal: new AbortController().signal,
    state: 'active',
    withFencedWrite,
  } as RegionAuthorityFence
  const assertCanConsume = jest.fn()
  const context: AuthorizedConsumedRegionContext = {
    assertCanConsume,
    authority,
    consumedRegion: 'local',
    executionRegion: 'local',
  }
  return { assertCanConsume, authority, context, query, transaction, withFencedWrite }
}

describe('fenced Tier-A publication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPublishSnapshot.mockImplementation(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        return { snapshotId: 77 }
      }
    )
    mockPublishTrustedSnapshot.mockImplementation(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishTrustedSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        return { snapshotId: 88 }
      }
    )
    mockPrepareBoardSeries.mockImplementation(() => boardPlan())
    mockPrepareAttemptEvidence.mockImplementation(() => preparedAttemptEvidence())
    mockFenceAttemptEvidence.mockResolvedValue(undefined)
    mockPublishBoardSeries.mockImplementation(
      async (
        transaction: WorkerDbFencedWrite,
        _prepared: PreparedBoardSeriesPublication,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        return { traders: 1, points: 1 }
      }
    )
  })

  it('locks and validates the live source before running the untrusted body on the same tx', async () => {
    const input = snapshotInput()
    const { assertCanConsume, context, query, transaction, withFencedWrite } = harness()

    await expect(publishFencedLeaderboardSnapshot(input, context)).resolves.toEqual({
      snapshotId: 77,
    })

    expect(assertCanConsume).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual([src.id])
    expect(String(query.mock.calls[0][0])).toMatch(
      /FROM arena\.sources AS source[\s\S]+WHERE source\.id = \$1::smallint[\s\S]+FOR SHARE OF source/
    )
    expect(mockPublishSnapshot).toHaveBeenCalledWith(transaction, input, expect.any(Function))
    expect(mockPublishTrustedSnapshot).not.toHaveBeenCalled()
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it('rolls back when cancellation arrives inside the publication transaction', async () => {
    const controller = new AbortController()
    const cancellation = new Error('source lease lost')
    const onCommit = jest.fn()
    const { context } = harness({ onCommit })
    mockPublishSnapshot.mockImplementationOnce(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        controller.abort(cancellation)
        return { snapshotId: 77 }
      }
    )

    await expect(
      publishFencedLeaderboardSnapshot(snapshotInput(), context, controller.signal)
    ).rejects.toBe(cancellation)

    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
    expect(onCommit).not.toHaveBeenCalled()
  })

  it('uses the same mandatory source lock and fenced transaction for trusted publication', async () => {
    const input = trustedInput()
    const { context, query, transaction, withFencedWrite } = harness()

    await expect(publishFencedTrustedLeaderboardSnapshot(input, context)).resolves.toEqual({
      snapshotId: 88,
    })

    expect(withFencedWrite).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledTimes(1)
    expect(mockPublishTrustedSnapshot).toHaveBeenCalledWith(
      transaction,
      input,
      expect.any(Function)
    )
    expect(mockPublishSnapshot).not.toHaveBeenCalled()
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it('publishes V4 through the attempt fence without writing metric trust', async () => {
    const prepared = preparedAttemptEvidence()
    mockPrepareAttemptEvidence.mockReturnValueOnce(prepared)
    mockPublishSnapshot.mockImplementationOnce(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        return {
          snapshotId: 99,
          scrapedAt: '2026-07-28T10:00:03.000Z',
          verdict: { passed: true, baselineUsed: 2, deviationPct: 0 },
          published: true,
          traderIds: new Map(),
        }
      }
    )
    const input = attemptBoundInput()
    const { context, query, transaction, withFencedWrite } = harness()

    await expect(publishFencedAttemptBoundLeaderboardSnapshot(input, context)).resolves.toEqual({
      snapshotId: 99,
      scrapedAt: '2026-07-28T10:00:03.000Z',
      verdict: { passed: true, baselineUsed: 2, deviationPct: 0 },
      published: true,
      traderIds: new Map(),
    })

    expect(mockPrepareAttemptEvidence).toHaveBeenCalledWith({
      src,
      timeframe: 30,
      rows: [],
      rejectedRowCount: 0,
      bundle: input.attemptEvidence,
    })
    expect(withFencedWrite).toHaveBeenCalledTimes(1)
    expect(mockPublishSnapshot).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({
        src,
        timeframe: 30,
        rows: [],
        rejects: [],
        rawObjectId: 201,
        isDerived: false,
      }),
      expect.any(Function)
    )
    expect(mockPublishTrustedSnapshot).not.toHaveBeenCalled()
    expect(query.mock.calls.some(([sql]) => String(sql).includes('arena.metric_trust'))).toBe(false)

    const bindingCallIndex = query.mock.calls.findIndex(([sql]) =>
      String(sql).includes('UPDATE arena.leaderboard_snapshots')
    )
    const bindingCall = query.mock.calls[bindingCallIndex]
    expect(bindingCall).toBeDefined()
    expect(bindingCall?.[1]).toEqual([
      99,
      JSON.stringify({
        source_run_id: 'a'.repeat(64),
        source_payload_raw_object_id: 201,
        manifest_raw_object_id: 202,
        acquisition_contract: 'arena.ingest.leaderboard-acquisition-manifest@4',
      }),
      src.id,
      30,
      '2026-07-28T10:00:03.000Z',
      201,
    ])
    expect(mockFenceAttemptEvidence).toHaveBeenCalledWith(transaction, prepared)
    expect(query.mock.invocationCallOrder[bindingCallIndex]).toBeLessThan(
      mockFenceAttemptEvidence.mock.invocationCallOrder[0]
    )
  })

  it.each(['latest terminal changed', 'RAW pointer mismatch', 'RAW hash mismatch'])(
    'rejects the fenced transaction without commit when V4 evidence fails: %s',
    async (reason) => {
      mockPublishSnapshot.mockImplementationOnce(
        async (
          transaction: WorkerDbFencedWrite,
          _input: PublishSnapshotInput,
          sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
        ) => {
          await sourceAuthorityGuard(transaction)
          mockPublicationWrite()
          return {
            snapshotId: 99,
            scrapedAt: '2026-07-28T10:00:03.000Z',
            verdict: { passed: true, baselineUsed: 2, deviationPct: 0 },
            published: true,
            traderIds: new Map(),
          }
        }
      )
      const failure = new Error(reason)
      mockFenceAttemptEvidence.mockRejectedValueOnce(failure)
      const onCommit = jest.fn()
      const { context, query } = harness({ onCommit })

      await expect(
        publishFencedAttemptBoundLeaderboardSnapshot(attemptBoundInput(), context)
      ).rejects.toBe(failure)

      expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
      expect(
        query.mock.calls.some(([sql]) => String(sql).includes('UPDATE arena.leaderboard_snapshots'))
      ).toBe(true)
      expect(onCommit).not.toHaveBeenCalled()
      expect(mockPublishTrustedSnapshot).not.toHaveBeenCalled()
    }
  )

  it('fails a wrong V4 contract before opening the fenced transaction', async () => {
    const failure = new Error('attempt-bound canonical publication requires a v4 manifest')
    mockPrepareAttemptEvidence.mockImplementationOnce(() => {
      throw failure
    })
    const { context, withFencedWrite } = harness()

    await expect(
      publishFencedAttemptBoundLeaderboardSnapshot(attemptBoundInput(), context)
    ).rejects.toBe(failure)

    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(mockPublishSnapshot).not.toHaveBeenCalled()
    expect(mockPublishTrustedSnapshot).not.toHaveBeenCalled()
  })

  it('publishes a prepared board plan through the same fenced transaction and source guard', async () => {
    const prepared = boardPlan()
    mockPrepareBoardSeries.mockReturnValueOnce(prepared)
    const { assertCanConsume, context, query, transaction, withFencedWrite } = harness()

    await expect(
      publishFencedBoardSeries(src, boardSeries, boardTraderIds, context, boardOptions)
    ).resolves.toEqual({ traders: 1, points: 1 })

    expect(mockPrepareBoardSeries).toHaveBeenCalledWith(
      src,
      boardSeries,
      boardTraderIds,
      boardOptions
    )
    expect(mockPrepareBoardSeries.mock.invocationCallOrder[0]).toBeLessThan(
      withFencedWrite.mock.invocationCallOrder[0]
    )
    expect(assertCanConsume).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).toHaveBeenCalledTimes(1)
    expect(mockPublishBoardSeries).toHaveBeenCalledWith(transaction, prepared, expect.any(Function))
    expect(query).toHaveBeenCalledTimes(1)
    expect(query.mock.calls[0][1]).toEqual([src.id])
    expect(String(query.mock.calls[0][0])).toMatch(
      /FROM arena\.sources AS source[\s\S]+WHERE source\.id = \$1::smallint[\s\S]+FOR SHARE OF source/
    )
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it('returns an empty board plan without opening a fenced transaction', async () => {
    mockPrepareBoardSeries.mockReturnValueOnce(
      boardPlan({
        expectedLatestSnapshots: [],
        rows: [],
        snapshotMemberships: [],
        traders: 0,
      })
    )
    const { assertCanConsume, context, query, withFencedWrite } = harness()

    await expect(
      publishFencedBoardSeries(src, boardSeries, boardTraderIds, context, boardOptions)
    ).resolves.toEqual({ traders: 0, points: 0 })

    expect(mockPrepareBoardSeries).toHaveBeenCalledTimes(1)
    expect(assertCanConsume).not.toHaveBeenCalled()
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(mockPublishBoardSeries).not.toHaveBeenCalled()
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it('rejects a board preparation failure before opening a fenced transaction', async () => {
    const failure = new Error('board plan rejected')
    mockPrepareBoardSeries.mockImplementationOnce(() => {
      throw failure
    })
    const { assertCanConsume, context, query, withFencedWrite } = harness()

    await expect(
      publishFencedBoardSeries(src, boardSeries, boardTraderIds, context, boardOptions)
    ).rejects.toBe(failure)

    expect(assertCanConsume).not.toHaveBeenCalled()
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
    expect(mockPublishBoardSeries).not.toHaveBeenCalled()
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it('blocks board writes when the live source guard rejects inside the fenced transaction', async () => {
    const { context, query, transaction, withFencedWrite } = harness({
      liveRows: [liveSourceRow({ fetch_region: 'vps_sg' })],
    })

    await expect(
      publishFencedBoardSeries(src, boardSeries, boardTraderIds, context, boardOptions)
    ).rejects.toMatchObject({ code: 'source_region_mismatch' })

    expect(withFencedWrite).toHaveBeenCalledTimes(1)
    expect(mockPublishBoardSeries).toHaveBeenCalledWith(
      transaction,
      expect.any(Object),
      expect.any(Function)
    )
    expect(query).toHaveBeenCalledTimes(1)
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it.each([7, 90] as const)(
    'fails closed before serving DML when an old worker publishes removed native %dd',
    async (timeframe) => {
      const { context, query } = harness({
        liveRows: [liveSourceRow({ timeframes_native: [30] })],
      })

      await expect(
        publishFencedLeaderboardSnapshot(snapshotInput({ timeframe }), context)
      ).rejects.toMatchObject({ code: 'source_configuration_mismatch' })

      expect(mockPublicationWrite).not.toHaveBeenCalled()
      expect(query).toHaveBeenCalledTimes(1)
      expect(
        query.mock.calls.every(([sql]) => !/\b(?:INSERT|UPDATE|DELETE)\b/i.test(String(sql)))
      ).toBe(true)
    }
  )

  it('rejects the reverse cached/live native-registry race before publication', async () => {
    const cachedSource = { ...src, timeframes_native: [30] } as SourceRow
    const { context } = harness({ liveRows: [liveSourceRow()] })

    await expect(
      publishFencedLeaderboardSnapshot(snapshotInput({ src: cachedSource, timeframe: 30 }), context)
    ).rejects.toMatchObject({ code: 'source_configuration_mismatch' })

    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it.each<[string, Partial<LiveSourceRow>]>([
    ['adapter slug', { adapter_slug: 'other-adapter' }],
    ['exchange id', { exchange_id: src.exchange_id + 1 }],
    ['serving mode', { serving_mode: 'shadow' }],
    ['product type', { product_type: 'spot' }],
    ['trader-kind scope', { trader_kind_scope: 'bot' }],
    ['page size', { page_size: 50 }],
    ['pagination kind', { pagination_kind: 'api_cursor' }],
    ['native timeframe registry', { timeframes_native: [30] }],
    ['derived timeframe registry', { timeframes_derived: [7] }],
  ])('rejects live source %s identity drift before publication DML', async (_label, drift) => {
    const { context, query } = harness({ liveRows: [liveSourceRow(drift)] })

    await expect(publishFencedLeaderboardSnapshot(snapshotInput(), context)).rejects.toMatchObject({
      code: 'source_configuration_mismatch',
    })

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['not live-native', { timeframes_native: [30], timeframes_derived: [7, 90] }],
    ['also live-derived', { timeframes_native: [7, 30], timeframes_derived: [7] }],
  ])('rejects a native snapshot timeframe that is %s', async (_label, registry) => {
    const source = { ...src, ...registry } as SourceRow
    const { context } = harness({ liveRows: [liveSourceRow(registry)] })

    await expect(
      publishFencedLeaderboardSnapshot(snapshotInput({ src: source, timeframe: 7 }), context)
    ).rejects.toMatchObject({ code: 'source_timeframe_not_native' })

    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it('validates every guarded board-series timeframe against the locked live registry', async () => {
    const source = {
      ...src,
      timeframes_native: [30],
      timeframes_derived: [7, 90],
    } as SourceRow
    mockPrepareBoardSeries.mockReturnValueOnce(boardPlanForTimeframes([30, 90]))
    const { context, query } = harness({
      liveRows: [liveSourceRow({ timeframes_native: [30], timeframes_derived: [7, 90] })],
    })

    await expect(
      publishFencedBoardSeries(source, boardSeries, boardTraderIds, context, boardOptions)
    ).rejects.toMatchObject({ code: 'source_timeframe_not_native' })

    expect(query).toHaveBeenCalledTimes(1)
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['historical human kind', { trader_kind: 'human', bot_strategy: null }],
    ['historical null kind', { trader_kind: null, bot_strategy: 'grid' }],
    ['historical null strategy', { trader_kind: 'bot', bot_strategy: null }],
    ['historical wrong strategy', { trader_kind: 'bot', bot_strategy: 'martingale' }],
  ])(
    'rejects bot identity drift from %s before snapshot/checkpoint DML',
    async (_label, stored) => {
      const source = { ...src, trader_kind_scope: 'bot' } as SourceRow
      const incoming = leaderboardRow({ traderKind: 'bot', botStrategy: 'grid' })
      const { context, query } = harness({
        liveRows: [liveSourceRow({ trader_kind_scope: 'bot' })],
        liveTraderRows: [{ exchange_trader_id: incoming.exchangeTraderId, ...stored }],
      })

      await expect(
        publishFencedLeaderboardSnapshot(snapshotInput({ src: source, rows: [incoming] }), context)
      ).rejects.toMatchObject({ code: 'trader_identity_mismatch' })

      expect(query).toHaveBeenCalledTimes(2)
      expect(String(query.mock.calls[1][0])).toMatch(
        /FROM arena\.traders AS trader[\s\S]+FOR SHARE OF trader/
      )
      expect(query.mock.calls[1][1]).toEqual([src.id, [incoming.exchangeTraderId]])
      expect(mockPublicationWrite).not.toHaveBeenCalled()
    }
  )

  it('allows an exact existing bot identity and keeps the identity read on the fenced tx', async () => {
    const source = { ...src, trader_kind_scope: 'bot' } as SourceRow
    const incoming = leaderboardRow({ traderKind: 'bot', botStrategy: 'grid' })
    const { context, query } = harness({
      liveRows: [liveSourceRow({ trader_kind_scope: 'bot' })],
      liveTraderRows: [
        {
          exchange_trader_id: incoming.exchangeTraderId,
          trader_kind: 'bot',
          bot_strategy: 'grid',
        },
      ],
    })

    await expect(
      publishFencedLeaderboardSnapshot(snapshotInput({ src: source, rows: [incoming] }), context)
    ).resolves.toEqual({ snapshotId: 77 })

    expect(query).toHaveBeenCalledTimes(2)
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it('applies the existing-trader identity guard to trusted snapshots too', async () => {
    const source = { ...src, trader_kind_scope: 'bot' } as SourceRow
    const incoming = leaderboardRow({ traderKind: 'bot', botStrategy: 'grid' })
    const { context } = harness({
      liveRows: [liveSourceRow({ trader_kind_scope: 'bot' })],
      liveTraderRows: [
        {
          exchange_trader_id: incoming.exchangeTraderId,
          trader_kind: 'human',
          bot_strategy: null,
        },
      ],
    })

    await expect(
      publishFencedTrustedLeaderboardSnapshot(
        trustedInput({ src: source, rows: [incoming] }),
        context
      )
    ).rejects.toMatchObject({ code: 'trader_identity_mismatch' })

    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it('reports a baseline shift only after the fenced commit is confirmed', async () => {
    const commit = deferred()
    const publicationWrite = deferred()
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockPublishSnapshot.mockImplementationOnce(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        publicationWrite.resolve()
        return {
          baselineShifted: true,
          published: true,
          scrapedAt: '2026-07-28T10:00:00.000Z',
          snapshotId: 77,
          traderIds: new Map(),
          verdict: { baselineUsed: 42, deviationPct: 0, passed: true },
        }
      }
    )
    const { context } = harness({ commitBarrier: commit.promise })

    try {
      const publication = publishFencedLeaderboardSnapshot(snapshotInput(), context)
      await publicationWrite.promise
      expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
      expect(warning).not.toHaveBeenCalled()

      commit.resolve()
      await expect(publication).resolves.toEqual(expect.objectContaining({ snapshotId: 77 }))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('adopting new baseline 42'))
    } finally {
      warning.mockRestore()
      commit.resolve()
    }
  })

  it.each([
    ['wrong region', { authorityRegion: 'vps_sg' as const }],
    ['wrong scope', { authorityScope: 'region:vps_sg' }],
    ['inactive fence', { active: false }],
  ])('rejects %s before opening a write transaction', async (_label, options) => {
    const { context, withFencedWrite } = harness(options)

    await expect(publishFencedLeaderboardSnapshot(snapshotInput(), context)).rejects.toMatchObject({
      code: 'authority_identity_mismatch',
    })
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(mockPublishSnapshot).not.toHaveBeenCalled()
  })

  it('rejects a stale source object before opening a write transaction', async () => {
    const { context, withFencedWrite } = harness()

    await expect(
      publishFencedLeaderboardSnapshot(
        { ...snapshotInput(), src: { ...src, fetch_region: 'vps_sg' } },
        context
      )
    ).rejects.toThrow('belongs to vps_sg')
    expect(withFencedWrite).not.toHaveBeenCalled()
  })

  it.each([
    ['missing source', [], 0, 'source_missing'],
    [
      'duplicate source',
      [liveSourceRow(), liveSourceRow()],
      2,
      'source_registry_contract_violation',
    ],
    ['wrong id', [liveSourceRow({ id: src.id + 1 })], 1, 'source_identity_mismatch'],
    ['wrong slug', [liveSourceRow({ slug: 'other' })], 1, 'source_identity_mismatch'],
    ['inactive source', [liveSourceRow({ status: 'inactive' })], 1, 'source_inactive'],
    ['moved source', [liveSourceRow({ fetch_region: 'vps_sg' })], 1, 'source_region_mismatch'],
  ])(
    'fails closed for a %s inside the fenced transaction',
    async (_label, liveRows, rowCount, code) => {
      const { context, withFencedWrite } = harness({ liveRows, rowCount })

      await expect(
        publishFencedLeaderboardSnapshot(snapshotInput(), context)
      ).rejects.toMatchObject({
        code,
      })
      expect(withFencedWrite).toHaveBeenCalledTimes(1)
      expect(mockPublishSnapshot).toHaveBeenCalledTimes(1)
      expect(mockPublicationWrite).not.toHaveBeenCalled()
    }
  )

  it('propagates a source-lock query failure without entering the publication body', async () => {
    const { context, query } = harness()
    const failure = new Error('source lock failed')
    query.mockRejectedValue(failure)

    await expect(publishFencedLeaderboardSnapshot(snapshotInput(), context)).rejects.toBe(failure)
    expect(mockPublishSnapshot).toHaveBeenCalledTimes(1)
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })
})
