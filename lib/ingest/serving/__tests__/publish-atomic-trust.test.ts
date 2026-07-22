import type { PoolClient } from 'pg'
import type { ParsedLeaderboardRow, SourceRow } from '../../core/types'

const mockConnect = jest.fn()
const mockPrepareTrust = jest.fn()
const mockReconcileTrust = jest.fn()
const mockWriteTrust = jest.fn()
const mockFenceCommit = jest.fn()

jest.mock('../../db', () => ({
  getIngestPool: jest.fn(() => {
    throw new Error('trusted publisher baseline must not use the pool')
  }),
  ingestClientConnect: (...args: unknown[]) => mockConnect(...args),
}))

jest.mock('../metric-trust-publish', () => ({
  snapshotLeaderboardTrustValue: (value: unknown) => JSON.parse(JSON.stringify(value)),
  fenceAttemptBoundLeaderboardPublicationCommit: (...args: unknown[]) => mockFenceCommit(...args),
  prepareLeaderboardMetricTrust: (...args: unknown[]) => mockPrepareTrust(...args),
  reconcileLeaderboardMetricTrust: (...args: unknown[]) => mockReconcileTrust(...args),
  writeLeaderboardMetricTrust: (...args: unknown[]) => mockWriteTrust(...args),
}))

import { publishTrustedLeaderboardSnapshot } from '../publish'

const src = {
  id: 1,
  slug: 'binance_futures',
  adapter_slug: 'binance',
  currency: 'USDT',
  expected_count: 1,
  meta: {},
} as SourceRow

const row: ParsedLeaderboardRow = {
  exchangeTraderId: 'portfolio-1',
  rank: 1,
  nickname: 'One',
  avatarUrlOrigin: null,
  walletAddress: null,
  traderKind: 'human',
  botStrategy: null,
  headlineRoi: 10,
  headlinePnl: 100,
  headlineWinRate: null,
  headlineMetricSources: {
    roi: { fieldPath: 'data.list[].roi' },
    pnl: { fieldPath: 'data.list[].pnl' },
  },
  raw: {},
}

const prepared = {
  src: { ...src, meta: {} },
  timeframe: 30,
  rows: [
    {
      ...row,
      headlineMetricSources: {
        roi: { fieldPath: 'data.list[].roi' },
        pnl: { fieldPath: 'data.list[].pnl' },
      },
      raw: {},
    },
  ],
  sourceRunId: 'a'.repeat(64),
  artifacts: {
    sourcePayload: { id: 101, contentHash: 'b'.repeat(64), storagePath: 'source' },
    populationManifest: { id: 102, contentHash: 'a'.repeat(64), storagePath: 'manifest' },
  },
  manifest: {
    completed_at: '2026-07-21T10:00:03.000Z',
    data_contract: 'arena.ingest.leaderboard-acquisition-manifest@2',
    observation_cycle_id: 'tier-a:binance_futures:job-1:1784628000000',
  },
  sourceAsOf: '2026-07-21T10:00:01.000Z',
  windowStart: '2026-06-21T10:00:01.000Z',
  expectedFields: [{ maxFreshnessMs: 6 * 60 * 60 * 1000 }],
} as never

const preparedV3 = {
  ...prepared,
  manifest: {
    completed_at: '2026-07-21T10:00:03.000Z',
    data_contract: 'arena.ingest.leaderboard-acquisition-manifest@3',
    observation_cycle_id: 'tier-a:binance_futures:job-1:1784628000000',
    acquisition_attempt: {
      binding_contract: 'arena.ingest.leaderboard-acquisition-attempt-binding@1',
      attempt_id: '00000000-0000-4000-8000-000000000001',
      attempt_seq: 41,
    },
  },
} as never

async function emulateAttemptBoundCommitFence(
  client: PoolClient,
  attemptBoundPrepared: { src: SourceRow; timeframe: number }
): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '5s'`)
  await client.query(
    `SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1, 0))`,
    [
      `arena.leaderboard-acquisition-source:${attemptBoundPrepared.src.id}:${attemptBoundPrepared.timeframe}`,
    ]
  )
  await client.query(
    `SELECT terminal.attempt_seq::text
       FROM arena.latest_terminal_leaderboard_acquisitions AS terminal`
  )
}

interface HarnessOptions {
  commitError?: Error
  rollbackError?: Error
  entryRowCount?: number
  databaseNow?: string
  latestPassedAt?: string
}

function clientHarness(options: HarnessOptions = {}) {
  const release = jest.fn()
  const query = jest.fn(async (sqlInput: unknown, _params?: unknown[]) => {
    const sql = String(sqlInput)
    if (
      sql.startsWith('BEGIN') ||
      sql.startsWith('SET LOCAL') ||
      sql.includes('pg_advisory_xact_lock') ||
      sql.includes('arena.latest_terminal_leaderboard_acquisitions')
    ) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.includes('statement_timestamp()::text AS database_now')) {
      return {
        rows: [
          {
            database_now: options.databaseNow ?? '2026-07-21T10:00:04.000Z',
            latest_scraped_at: options.latestPassedAt ?? null,
          },
        ],
        rowCount: 1,
      }
    }
    if (sql.includes('WITH observations AS')) return { rows: [], rowCount: 0 }
    if (sql.includes('INSERT INTO arena.leaderboard_snapshots')) {
      return {
        rows: [{ id: 77, scraped_at: '2026-07-21 10:00:03.000000+00' }],
        rowCount: 1,
      }
    }
    if (sql.includes('INSERT INTO arena.traders')) {
      return { rows: [{ id: 1_001, exchange_trader_id: row.exchangeTraderId }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO arena.leaderboard_entries')) {
      return { rows: [], rowCount: options.entryRowCount ?? 1 }
    }
    if (sql.includes('INSERT INTO arena.trader_stats')) return { rows: [], rowCount: 1 }
    if (sql === 'COMMIT') {
      if (options.commitError) throw options.commitError
      return { rows: [], rowCount: 0 }
    }
    if (sql === 'ROLLBACK') {
      if (options.rollbackError) throw options.rollbackError
      return { rows: [], rowCount: 0 }
    }
    throw new Error(`unexpected SQL: ${sql}`)
  })
  return { client: { query, release } as unknown as PoolClient, query, release }
}

function trustedInput() {
  return {
    src,
    timeframe: 30 as const,
    rows: [row],
    rejects: [],
    observationCycleId: 'tier-a:binance_futures:job-1:1784628000000',
    trust: {} as never,
  }
}

function existingTrustedPublication() {
  return {
    snapshotId: 77,
    scrapedAt: '2026-07-21T10:00:03.000Z',
    expectedCount: 1,
    actualCount: 1,
    baselineUsed: 1,
    traderIds: new Map([[row.exchangeTraderId, 1_001]]),
    trust: {
      sourceRunId: 'a'.repeat(64),
      observationsWritten: 2,
      artifactRefsWritten: 4,
      replayed: true,
    },
  }
}

describe('atomic trusted leaderboard publication', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPrepareTrust.mockReturnValue(prepared)
    mockReconcileTrust.mockResolvedValue(null)
    mockFenceCommit.mockImplementation(emulateAttemptBoundCommitFence)
    mockWriteTrust.mockResolvedValue({
      sourceRunId: 'a'.repeat(64),
      observationsWritten: 2,
      artifactRefsWritten: 4,
    })
  })

  it('locks before reading the baseline and commits serving plus trust together', async () => {
    const harness = clientHarness()
    mockConnect.mockResolvedValue(harness.client)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).resolves.toEqual(
      expect.objectContaining({
        snapshotId: 77,
        published: true,
        trust: {
          sourceRunId: 'a'.repeat(64),
          observationsWritten: 2,
          artifactRefsWritten: 4,
          replayed: false,
        },
      })
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    const lockIndex = statements.findIndex((sql) => sql.includes('pg_advisory_xact_lock'))
    const baselineIndex = statements.findIndex((sql) => sql.includes('WITH observations AS'))
    const commitIndex = statements.indexOf('COMMIT')
    expect(lockIndex).toBeGreaterThan(-1)
    expect(baselineIndex).toBeGreaterThan(lockIndex)
    expect(mockWriteTrust.mock.invocationCallOrder[0]).toBeLessThan(
      harness.query.mock.invocationCallOrder[commitIndex]
    )
    expect(mockFenceCommit).not.toHaveBeenCalled()
    expect(harness.release).toHaveBeenCalledWith(false)
  })

  it('runs the v3 final fence after all new writes and immediately before COMMIT', async () => {
    const harness = clientHarness()
    mockConnect.mockResolvedValue(harness.client)
    mockPrepareTrust.mockReturnValue(preparedV3)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).resolves.toEqual(
      expect.objectContaining({
        published: true,
        trust: expect.objectContaining({ replayed: false }),
      })
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    const setTimeoutIndex = statements.indexOf(`SET LOCAL lock_timeout = '5s'`)
    const acquisitionLockIndex = harness.query.mock.calls.findIndex(
      ([, params]) =>
        (params as string[] | undefined)?.[0] === 'arena.leaderboard-acquisition-source:1:30'
    )
    const terminalCheckIndex = statements.findIndex((sql) =>
      sql.includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')
    )
    const commitIndex = statements.indexOf('COMMIT')
    const commitOrder = harness.query.mock.invocationCallOrder[commitIndex]
    const fenceOrder = mockFenceCommit.mock.invocationCallOrder[0]
    expect(mockFenceCommit).toHaveBeenCalledWith(harness.client, preparedV3)
    expect(mockWriteTrust.mock.invocationCallOrder[0]).toBeLessThan(fenceOrder)
    expect(fenceOrder).toBeLessThan(harness.query.mock.invocationCallOrder[setTimeoutIndex])
    expect(setTimeoutIndex).toBeLessThan(acquisitionLockIndex)
    expect(acquisitionLockIndex).toBeLessThan(terminalCheckIndex)
    expect(commitIndex).toBe(terminalCheckIndex + 1)
    expect(harness.query.mock.invocationCallOrder[terminalCheckIndex]).toBeLessThan(commitOrder)
  })

  it('runs the v3 final fence after exact existing replay reconciliation and before COMMIT', async () => {
    const harness = clientHarness()
    mockConnect.mockResolvedValue(harness.client)
    mockPrepareTrust.mockReturnValue(preparedV3)
    mockReconcileTrust.mockResolvedValue(existingTrustedPublication())

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).resolves.toEqual(
      expect.objectContaining({
        published: true,
        trust: expect.objectContaining({ replayed: true }),
      })
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    const setTimeoutIndex = statements.indexOf(`SET LOCAL lock_timeout = '5s'`)
    const acquisitionLockIndex = harness.query.mock.calls.findIndex(
      ([, params]) =>
        (params as string[] | undefined)?.[0] === 'arena.leaderboard-acquisition-source:1:30'
    )
    const terminalCheckIndex = statements.findIndex((sql) =>
      sql.includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')
    )
    const commitOrder = harness.query.mock.invocationCallOrder[statements.indexOf('COMMIT')]
    const fenceOrder = mockFenceCommit.mock.invocationCallOrder[0]
    expect(mockWriteTrust).not.toHaveBeenCalled()
    expect(mockReconcileTrust.mock.invocationCallOrder[0]).toBeLessThan(fenceOrder)
    expect(fenceOrder).toBeLessThan(harness.query.mock.invocationCallOrder[setTimeoutIndex])
    expect(setTimeoutIndex).toBeLessThan(acquisitionLockIndex)
    expect(acquisitionLockIndex).toBeLessThan(terminalCheckIndex)
    expect(statements.indexOf('COMMIT')).toBe(terminalCheckIndex + 1)
    expect(harness.query.mock.invocationCallOrder[terminalCheckIndex]).toBeLessThan(commitOrder)
  })

  it.each([
    ['new write', null],
    ['existing replay', existingTrustedPublication()],
  ])('rolls back a v3 %s when the final fence rejects', async (_path, existing) => {
    const harness = clientHarness()
    const fenceError = new Error('latest terminal changed under final fence')
    mockConnect.mockResolvedValue(harness.client)
    mockPrepareTrust.mockReturnValue(preparedV3)
    mockReconcileTrust.mockResolvedValue(existing)
    mockFenceCommit.mockImplementation(
      async (client: PoolClient, attemptBoundPrepared: { src: SourceRow; timeframe: number }) => {
        await emulateAttemptBoundCommitFence(client, attemptBoundPrepared)
        throw fenceError
      }
    )

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).rejects.toBe(fenceError)

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    const terminalCheckIndex = statements.findIndex((sql) =>
      sql.includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')
    )
    expect(mockFenceCommit).toHaveBeenCalledTimes(1)
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(statements.indexOf('ROLLBACK')).toBe(terminalCheckIndex + 1)
    expect(harness.release).toHaveBeenCalledWith(false)
  })

  it('rolls the entire PG publication back when trust writing fails', async () => {
    const harness = clientHarness()
    const trustError = new Error('observation chunk failed')
    mockConnect.mockResolvedValue(harness.client)
    mockWriteTrust.mockRejectedValue(trustError)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).rejects.toBe(trustError)

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('ROLLBACK')
    expect(statements).not.toContain('COMMIT')
    expect(harness.release).toHaveBeenCalledWith(false)
  })

  it('treats a short INSERT SELECT as corruption and rolls back before trust', async () => {
    const harness = clientHarness({ entryRowCount: 0 })
    mockConnect.mockResolvedValue(harness.client)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).rejects.toThrow(
      'leaderboard entry insert count mismatch'
    )

    expect(mockWriteTrust).not.toHaveBeenCalled()
    expect(harness.query.mock.calls.map(([sql]) => String(sql))).toContain('ROLLBACK')
  })

  it('rejects an older capture under the source lock before it can overwrite latest stats', async () => {
    const harness = clientHarness({ latestPassedAt: '2026-07-21T10:00:04.000Z' })
    mockConnect.mockResolvedValue(harness.client)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).rejects.toThrow(
      'stale leaderboard publication rejected'
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('ROLLBACK')
    expect(statements.some((sql) => sql.includes('WITH observations AS'))).toBe(false)
    expect(statements.some((sql) => sql.includes('INSERT INTO arena.leaderboard_snapshots'))).toBe(
      false
    )
    expect(mockWriteTrust).not.toHaveBeenCalled()
  })

  it('rejects capture evidence that has already exceeded the registered freshness contract', async () => {
    const harness = clientHarness({ databaseNow: '2026-07-21T16:00:01.000Z' })
    mockConnect.mockResolvedValue(harness.client)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).rejects.toThrow(
      'trusted capture evidence expired before publication'
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('ROLLBACK')
    expect(statements.some((sql) => sql.includes('WITH observations AS'))).toBe(false)
    expect(statements.some((sql) => sql.includes('INSERT INTO arena.leaderboard_snapshots'))).toBe(
      false
    )
    expect(mockWriteTrust).not.toHaveBeenCalled()
  })

  it('rejects capture timestamps more than five minutes ahead of the database clock', async () => {
    const harness = clientHarness({ databaseNow: '2026-07-21T09:54:59.000Z' })
    mockConnect.mockResolvedValue(harness.client)

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).rejects.toThrow(
      'trusted capture timestamp is more than five minutes in the future'
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    expect(statements).toContain('ROLLBACK')
    expect(statements.some((sql) => sql.includes('WITH observations AS'))).toBe(false)
    expect(statements.some((sql) => sql.includes('INSERT INTO arena.leaderboard_snapshots'))).toBe(
      false
    )
    expect(mockWriteTrust).not.toHaveBeenCalled()
  })

  it('publishes the prepared snapshot even if the caller mutates its input after preparation', async () => {
    const mutableSource = { ...src, meta: { caller: 'original' } }
    const mutableRow = {
      ...row,
      headlineMetricSources: {
        roi: { fieldPath: 'data.list[].roi' },
        pnl: { fieldPath: 'data.list[].pnl' },
      },
      raw: { caller: 'original' },
    }
    const mutableInput = {
      ...trustedInput(),
      src: mutableSource,
      rows: [mutableRow],
    }
    mockPrepareTrust.mockImplementationOnce((input: typeof mutableInput) => ({
      ...prepared,
      src: JSON.parse(JSON.stringify(input.src)),
      timeframe: input.timeframe,
      rows: JSON.parse(JSON.stringify(input.rows)),
    }))

    let resolveClient!: (client: PoolClient) => void
    const waitingForClient = new Promise<PoolClient>((resolve) => {
      resolveClient = resolve
    })
    const harness = clientHarness()
    mockConnect.mockReturnValue(waitingForClient)

    const publication = publishTrustedLeaderboardSnapshot(mutableInput)
    mutableSource.id = 999
    mutableSource.slug = 'mutated_source'
    mutableRow.exchangeTraderId = 'mutated-portfolio'
    mutableRow.headlineRoi = 999
    mutableRow.raw.caller = 'mutated'
    resolveClient(harness.client)

    await expect(publication).resolves.toEqual(expect.objectContaining({ published: true }))

    const lockCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('pg_advisory_xact_lock')
    )
    expect(lockCall?.[1]).toEqual([`arena.publish-board-series:${src.id}`])
    const tradersCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.traders')
    )
    const entriesCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.leaderboard_entries')
    )
    const statsCall = harness.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.trader_stats')
    )
    expect(String(tradersCall?.[1]?.[1])).toContain('portfolio-1')
    expect(String(tradersCall?.[1]?.[1])).not.toContain('mutated-portfolio')
    expect(String(entriesCall?.[1]?.[4])).toContain('"roi":10')
    expect(String(entriesCall?.[1]?.[4])).not.toContain('"roi":999')
    expect(String(statsCall?.[1]?.[3])).toContain('portfolio-1')
    expect(mockWriteTrust.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        src: expect.objectContaining({ id: src.id, slug: src.slug }),
        rows: [expect.objectContaining({ exchangeTraderId: 'portfolio-1', headlineRoi: 10 })],
      })
    )
  })

  it('destroys an ambiguous COMMIT client and returns only after exact fresh reconciliation', async () => {
    const commitError = new Error('connection lost during COMMIT')
    const primary = clientHarness({ commitError })
    const reconciliation = clientHarness()
    mockConnect.mockResolvedValueOnce(primary.client).mockResolvedValueOnce(reconciliation.client)
    mockPrepareTrust.mockReturnValue(preparedV3)
    mockReconcileTrust
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingTrustedPublication())

    await expect(publishTrustedLeaderboardSnapshot(trustedInput())).resolves.toEqual(
      expect.objectContaining({
        published: true,
        trust: expect.objectContaining({ replayed: true }),
      })
    )

    expect(primary.release).toHaveBeenCalledWith(true)
    expect(reconciliation.release).toHaveBeenCalledWith(false)
    expect(reconciliation.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'COMMIT',
    ])
    expect(mockFenceCommit).toHaveBeenCalledTimes(1)
    expect(mockFenceCommit).toHaveBeenCalledWith(primary.client, preparedV3)
    expect(mockFenceCommit).not.toHaveBeenCalledWith(reconciliation.client, preparedV3)
    expect(
      reconciliation.query.mock.calls.some(([sql]) =>
        /pg_advisory_xact_lock|FOR UPDATE/i.test(String(sql))
      )
    ).toBe(false)
    expect(primary.query.mock.calls.map(([sql]) => String(sql))).not.toContain('ROLLBACK')
  })

  it('preserves explicit no-run evidence after an ambiguous COMMIT', async () => {
    const commitError = new Error('connection lost during COMMIT')
    const primary = clientHarness({ commitError })
    const reconciliation = clientHarness()
    mockConnect.mockResolvedValueOnce(primary.client).mockResolvedValueOnce(reconciliation.client)
    mockReconcileTrust.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    let failure: unknown
    try {
      await publishTrustedLeaderboardSnapshot(trustedInput())
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors[0]).toBe(commitError)
    expect((failure as AggregateError).errors[1]).toEqual(
      expect.objectContaining({
        message: '[publish] fresh reconciliation found no committed trusted publication',
      })
    )
    expect(reconciliation.query.mock.calls.map(([sql]) => String(sql))).toEqual([
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'ROLLBACK',
    ])
    expect(reconciliation.release).toHaveBeenCalledWith(false)
  })

  it('preserves both COMMIT and reconciliation failures', async () => {
    const commitError = new Error('connection lost during COMMIT')
    const reconcileError = new Error('artifact ref missing')
    const primary = clientHarness({ commitError })
    const reconciliation = clientHarness()
    mockConnect.mockResolvedValueOnce(primary.client).mockResolvedValueOnce(reconciliation.client)
    mockReconcileTrust.mockResolvedValueOnce(null).mockRejectedValueOnce(reconcileError)

    let failure: unknown
    try {
      await publishTrustedLeaderboardSnapshot(trustedInput())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([commitError, reconcileError])
    expect(primary.release).toHaveBeenCalledWith(true)
  })

  it('preserves both the primary and rollback failures and destroys the client', async () => {
    const trustError = new Error('trust insert failed')
    const rollbackError = new Error('rollback connection lost')
    const harness = clientHarness({ rollbackError })
    mockConnect.mockResolvedValue(harness.client)
    mockWriteTrust.mockRejectedValue(trustError)

    let failure: unknown
    try {
      await publishTrustedLeaderboardSnapshot(trustedInput())
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).errors).toEqual([trustError, rollbackError])
    expect(harness.release).toHaveBeenCalledWith(true)
  })
})
