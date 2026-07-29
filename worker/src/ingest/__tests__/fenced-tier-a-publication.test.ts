import type { BoardSeriesBlock, SourceRow } from '@/lib/ingest/core/types'
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
const mockClaimedWrites = new WeakSet<object>()
const mockAssertTierAExecutionClaimedWrite = jest.fn((value: unknown) => {
  if (value === null || typeof value !== 'object' || !mockClaimedWrites.has(value)) {
    throw new Error('forged or revoked claimed write')
  }
})

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

jest.mock('../source-job-execution-authority', () => {
  const actual = jest.requireActual('../source-job-execution-authority')
  return {
    ...actual,
    assertTierAExecutionClaimedWrite: (value: unknown) =>
      mockAssertTierAExecutionClaimedWrite(value),
  }
})

import {
  publishClaimedAttemptBoundLeaderboardSnapshot,
  publishClaimedBoardSeries,
  publishClaimedLeaderboardSnapshot,
  publishClaimedTrustedLeaderboardSnapshot,
  type PublishAttemptBoundLeaderboardSnapshotInput,
} from '../fenced-tier-a-publication'
import {
  SOURCE_JOB_EXECUTION_CONTRACT,
  type SourceJobExecutionAuthority,
  type SourceJobExecutionClaimProof,
  type TierAExecutionClaimedWrite,
} from '../source-job-execution-authority'

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

const WORKER_INSTANCE_ID = '44444444-4444-4444-8444-444444444444'

function executionClaimProof(
  overrides: Partial<SourceJobExecutionClaimProof> = {}
): SourceJobExecutionClaimProof {
  return Object.freeze({
    contract: SOURCE_JOB_EXECUTION_CONTRACT,
    sourceId: src.id,
    generationSeq: 7,
    claimId: '11111111-1111-4111-8111-111111111111',
    bullProofContract: 'arena.ingest.bull-job-provenance@1',
    queueName: 'arena:ingest:local',
    queueJobId: 'repeat:tiera:xt_futures',
    queueJobName: 'tiera:leaderboard',
    queueAttempt: 0,
    queueAttemptStarted: 1,
    bullLockTokenSha256: 'a'.repeat(64),
    sourceLeaseContract: 'arena.ingest.source-job-lease-provenance@1',
    sourceLeaseId: '22222222-2222-4222-8222-222222222222',
    sourceLeaseLane: 'tier-a',
    sourceLeaseScopeId: src.slug,
    sourceLeaseTokenSha256: 'b'.repeat(64),
    executionRegion: 'local',
    authorityScope: 'region:local',
    authorityEpoch: 34,
    workerInstanceId: WORKER_INSTANCE_ID,
    workerNodeId: 'worker-local-1',
    workerRegion: 'local',
    controlEpoch: 12,
    releaseId: 'c'.repeat(64),
    gitSha: 'd'.repeat(40),
    leaseSeconds: 90,
    phase: 'active',
    claimedAt: '2026-07-28T10:00:00.000Z',
    lastHeartbeatAt: '2026-07-28T10:00:00.000Z',
    leaseExpiresAt: '2026-07-28T10:01:30.000Z',
    ...overrides,
  } as SourceJobExecutionClaimProof)
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

function claimedHarness(options?: {
  commitBarrier?: Promise<void>
  executionProof?: Partial<SourceJobExecutionClaimProof>
  forgedTransaction?: boolean
  liveTraderRows?: unknown[]
  liveRows?: unknown[]
  onCommit?: jest.Mock
  rowCount?: number | null
  snapshotBindingRowCount?: number | null
  traderRowCount?: number | null
}) {
  const base = harness({
    liveTraderRows: options?.liveTraderRows,
    liveRows: options?.liveRows,
    rowCount: options?.rowCount,
    snapshotBindingRowCount: options?.snapshotBindingRowCount,
    traderRowCount: options?.traderRowCount,
  })
  const regionProof = Object.freeze({
    authorityScope: 'region:local' as const,
    controlEpoch: 12,
    controlServerTimeMs: 2_000,
    databaseEpoch: 34,
    databaseLeaseExpiresAt: '2026-07-28T10:03:00.000Z',
    databaseServerTime: '2026-07-28T10:00:00.000Z',
    initialControlServerTimeMs: 1_000,
    instanceId: WORKER_INSTANCE_ID,
    nodeId: 'worker-local-1',
    region: 'local' as const,
  })
  const authority = Object.freeze({
    ...base.authority,
    proof: regionProof,
  }) as RegionAuthorityFence
  const context = Object.freeze({
    assertCanConsume: base.assertCanConsume,
    authority,
    consumedRegion: 'local' as const,
    executionRegion: 'local' as const,
  }) satisfies AuthorizedConsumedRegionContext
  const transaction = base.transaction as TierAExecutionClaimedWrite
  const forgedTransaction = Object.freeze({
    query: base.query,
    signal: transaction.signal,
  }) as TierAExecutionClaimedWrite
  const rollback = jest.fn()
  const executionAssertActive = jest.fn()
  const withClaimedWrite = jest.fn(
    async <T>(callback: (candidate: TierAExecutionClaimedWrite) => Promise<T>): Promise<T> => {
      const candidate = options?.forgedTransaction ? forgedTransaction : transaction
      if (!options?.forgedTransaction) mockClaimedWrites.add(candidate)
      try {
        const result = await callback(candidate)
        if (options?.commitBarrier !== undefined) await options.commitBarrier
        options?.onCommit?.()
        return result
      } catch (error) {
        rollback()
        throw error
      } finally {
        mockClaimedWrites.delete(candidate)
      }
    }
  )
  const execution = Object.freeze({
    proof: executionClaimProof(options?.executionProof),
    signal: transaction.signal,
    assertActive: executionAssertActive,
    close: jest.fn(),
    heartbeat: jest.fn(),
    withClaimedWrite,
  }) as SourceJobExecutionAuthority
  return {
    ...base,
    authority,
    context,
    execution,
    executionAssertActive,
    forgedTransaction,
    rollback,
    transaction,
    withClaimedWrite,
  }
}

describe('execution-claimed Tier-A publication', () => {
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

  it('publishes a snapshot through one branded execution transaction without nesting region authority', async () => {
    const { context, execution, query, transaction, withClaimedWrite, withFencedWrite } =
      claimedHarness()

    await expect(
      publishClaimedLeaderboardSnapshot(snapshotInput(), context, execution)
    ).resolves.toEqual({ snapshotId: 77 })

    expect(withClaimedWrite).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(mockPublishSnapshot).toHaveBeenCalledWith(
      transaction,
      expect.any(Object),
      expect.any(Function)
    )
    expect(query).toHaveBeenCalledTimes(1)
    expect(mockAssertTierAExecutionClaimedWrite).toHaveBeenCalled()
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it('publishes trusted snapshots on the claimed transaction without a compatibility fallback', async () => {
    const { context, execution, transaction, withClaimedWrite, withFencedWrite } = claimedHarness()
    const input = trustedInput()

    await expect(
      publishClaimedTrustedLeaderboardSnapshot(input, context, execution)
    ).resolves.toEqual({ snapshotId: 88 })

    expect(withClaimedWrite).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(mockPublishTrustedSnapshot).toHaveBeenCalledWith(
      transaction,
      input,
      expect.any(Function)
    )
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it('keeps V4 snapshot, evidence binding, and terminal fence on the claimed transaction', async () => {
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
    const { context, execution, query, transaction, withFencedWrite } = claimedHarness()

    await expect(
      publishClaimedAttemptBoundLeaderboardSnapshot(attemptBoundInput(), context, execution)
    ).resolves.toEqual(expect.objectContaining({ snapshotId: 99 }))

    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(mockPublishSnapshot).toHaveBeenCalledWith(
      transaction,
      expect.objectContaining({ rawObjectId: 201, isDerived: false }),
      expect.any(Function)
    )
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('UPDATE arena.leaderboard_snapshots'))
    ).toBe(true)
    expect(mockFenceAttemptEvidence).toHaveBeenCalledWith(transaction, prepared)
  })

  it('publishes board series through the same claimed transaction and source guard', async () => {
    const prepared = boardPlan()
    mockPrepareBoardSeries.mockReturnValueOnce(prepared)
    const { context, execution, transaction, withClaimedWrite, withFencedWrite } = claimedHarness()

    await expect(
      publishClaimedBoardSeries(src, boardSeries, boardTraderIds, context, execution, boardOptions)
    ).resolves.toEqual({ traders: 1, points: 1 })

    expect(withClaimedWrite).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(mockPublishBoardSeries).toHaveBeenCalledWith(transaction, prepared, expect.any(Function))
    expect(mockPublicationWrite).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['wrong source', { sourceId: src.id + 1 }],
    ['wrong region authority generation', { authorityEpoch: 35 }],
    ['wrong worker context', { workerInstanceId: '55555555-5555-4555-8555-555555555555' }],
  ] satisfies ReadonlyArray<[string, Partial<SourceJobExecutionClaimProof>]>)(
    'rejects an execution claim bound to the %s before opening a transaction',
    async (_label, executionProof) => {
      const { context, execution, withClaimedWrite, withFencedWrite } = claimedHarness({
        executionProof,
      })

      await expect(
        publishClaimedLeaderboardSnapshot(snapshotInput(), context, execution)
      ).rejects.toMatchObject({ code: 'execution_authority_mismatch' })

      expect(withClaimedWrite).not.toHaveBeenCalled()
      expect(withFencedWrite).not.toHaveBeenCalled()
      expect(mockPublishSnapshot).not.toHaveBeenCalled()
      expect(mockPublicationWrite).not.toHaveBeenCalled()
    }
  )

  it('rejects a forged transaction exposed by an execution-shaped object before source SQL', async () => {
    const { context, execution, query, rollback, withClaimedWrite, withFencedWrite } =
      claimedHarness({ forgedTransaction: true })

    await expect(
      publishClaimedLeaderboardSnapshot(snapshotInput(), context, execution)
    ).rejects.toMatchObject({ code: 'execution_transaction_unauthorized' })

    expect(withClaimedWrite).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
    expect(mockPublishSnapshot).not.toHaveBeenCalled()
  })

  it('rolls back when a claimed transaction is revoked before the source guard', async () => {
    mockPublishSnapshot.mockImplementationOnce(
      async (
        transaction: WorkerDbFencedWrite,
        _input: PublishSnapshotInput,
        sourceAuthorityGuard: (candidate: WorkerDbFencedWrite) => Promise<void>
      ) => {
        mockClaimedWrites.delete(transaction)
        await sourceAuthorityGuard(transaction)
        mockPublicationWrite()
        return { snapshotId: 77 }
      }
    )
    const { context, execution, query, rollback, withFencedWrite } = claimedHarness()

    await expect(
      publishClaimedLeaderboardSnapshot(snapshotInput(), context, execution)
    ).rejects.toMatchObject({ code: 'execution_transaction_unauthorized' })

    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it('preserves a publisher callback error identity and delegates rollback to the execution owner', async () => {
    const failure = new Error('snapshot validation failed')
    mockPublishSnapshot.mockRejectedValueOnce(failure)
    const { context, execution, rollback, withClaimedWrite, withFencedWrite } = claimedHarness()

    await expect(
      publishClaimedLeaderboardSnapshot(snapshotInput(), context, execution)
    ).rejects.toBe(failure)

    expect(withClaimedWrite).toHaveBeenCalledTimes(1)
    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(mockPublicationWrite).not.toHaveBeenCalled()
  })

  it('rolls back if a publisher omits the mandatory claimed source guard', async () => {
    mockPublishSnapshot.mockResolvedValueOnce({ snapshotId: 77 })
    const { context, execution, query, rollback, withFencedWrite } = claimedHarness()

    await expect(
      publishClaimedLeaderboardSnapshot(snapshotInput(), context, execution)
    ).rejects.toMatchObject({ code: 'source_registry_contract_violation' })

    expect(withFencedWrite).not.toHaveBeenCalled()
    expect(rollback).toHaveBeenCalledTimes(1)
    expect(query).not.toHaveBeenCalled()
  })
})
