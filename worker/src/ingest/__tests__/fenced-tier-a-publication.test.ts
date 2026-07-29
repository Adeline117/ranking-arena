import type { BoardSeriesBlock, SourceRow } from '@/lib/ingest/core/types'
import type {
  PreparedBoardSeriesPublication,
  PublishBoardSeriesOptions,
  PublishSnapshotInput,
  PublishTrustedSnapshotInput,
} from '@/lib/ingest/serving/publish'

import type { AuthorizedConsumedRegionContext } from '../consumed-region-context'
import type { RegionAuthorityFence } from '../region-authority-lifecycle'
import type { WorkerDbFencedWrite } from '../worker-db-fence'
import { validateWorkerDbFencedWriteStatement } from '../worker-db-fence'

const mockPublishSnapshot = jest.fn()
const mockPublishTrustedSnapshot = jest.fn()
const mockPrepareBoardSeries = jest.fn()
const mockPublishBoardSeries = jest.fn()
const mockPublicationWrite = jest.fn()

jest.mock('@/lib/ingest/serving/publish', () => ({
  prepareBoardSeriesPublication: (...args: unknown[]) => mockPrepareBoardSeries(...args),
  publishBoardSeriesInTransaction: (...args: unknown[]) => mockPublishBoardSeries(...args),
  publishLeaderboardSnapshotInTransaction: (...args: unknown[]) => mockPublishSnapshot(...args),
  publishTrustedLeaderboardSnapshotInTransaction: (...args: unknown[]) =>
    mockPublishTrustedSnapshot(...args),
}))

import {
  publishFencedBoardSeries,
  publishFencedLeaderboardSnapshot,
  publishFencedTrustedLeaderboardSnapshot,
} from '../fenced-tier-a-publication'

const src = {
  id: 19,
  slug: 'xt_futures',
  currency: 'USDT',
  fetch_region: 'local',
  status: 'active',
} as SourceRow

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

function snapshotInput(): PublishSnapshotInput {
  return {
    src,
    timeframe: 30,
    rows: [],
    rejects: [],
    rawObjectId: 9001,
  }
}

function trustedInput(): PublishTrustedSnapshotInput {
  return {
    src,
    timeframe: 30,
    rows: [],
    rejects: [],
    trust: {} as never,
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
  liveRows?: unknown[]
  rowCount?: number | null
}) {
  const query = jest.fn(async (text: string) => {
    validateWorkerDbFencedWriteStatement(text)
    return {
      rows: options?.liveRows ?? [
        {
          fetch_region: 'local',
          id: src.id,
          slug: src.slug,
          status: 'active',
        },
      ],
      rowCount: options?.rowCount === undefined ? 1 : options.rowCount,
    }
  })
  const transaction = Object.freeze({
    query,
    signal: new AbortController().signal,
  }) as WorkerDbFencedWrite
  const withFencedWrite = jest.fn(
    async <T>(callback: (candidate: WorkerDbFencedWrite) => Promise<T>): Promise<T> => {
      const result = await callback(transaction)
      if (options?.commitBarrier !== undefined) await options.commitBarrier
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
      liveRows: [{ fetch_region: 'vps_sg', id: src.id, slug: src.slug, status: 'active' }],
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

  it('reports a baseline shift only after the fenced commit is confirmed', async () => {
    const commit = deferred()
    const warning = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockPublishSnapshot.mockImplementationOnce(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
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
      await Promise.resolve()
      await Promise.resolve()
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
      [
        { fetch_region: 'local', id: src.id, slug: src.slug, status: 'active' },
        { fetch_region: 'local', id: src.id, slug: src.slug, status: 'active' },
      ],
      2,
      'source_registry_contract_violation',
    ],
    [
      'wrong id',
      [{ fetch_region: 'local', id: src.id + 1, slug: src.slug, status: 'active' }],
      1,
      'source_identity_mismatch',
    ],
    [
      'wrong slug',
      [{ fetch_region: 'local', id: src.id, slug: 'other', status: 'active' }],
      1,
      'source_identity_mismatch',
    ],
    [
      'inactive source',
      [{ fetch_region: 'local', id: src.id, slug: src.slug, status: 'inactive' }],
      1,
      'source_inactive',
    ],
    [
      'moved source',
      [{ fetch_region: 'vps_sg', id: src.id, slug: src.slug, status: 'active' }],
      1,
      'source_region_mismatch',
    ],
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
