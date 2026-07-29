import type { PoolClient } from 'pg'
import type { ParsedLeaderboardRow, SourceRow } from '../../core/types'

const mockPrepareTrust = jest.fn()
const mockReconcileTrust = jest.fn()
const mockWriteTrust = jest.fn()
const mockFenceCommit = jest.fn()

jest.mock('../../db', () => ({
  getIngestPool: jest.fn(() => {
    throw new Error('trusted publisher baseline must not use the pool')
  }),
  ingestClientConnect: jest.fn(() => {
    throw new Error('trusted transaction body must not open a connection')
  }),
}))

jest.mock('../metric-trust-publish', () => ({
  snapshotLeaderboardTrustValue: (value: unknown) => JSON.parse(JSON.stringify(value)),
  fenceAttemptBoundLeaderboardPublicationCommit: (...args: unknown[]) => mockFenceCommit(...args),
  prepareLeaderboardMetricTrust: (...args: unknown[]) => mockPrepareTrust(...args),
  reconcileLeaderboardMetricTrust: (...args: unknown[]) => mockReconcileTrust(...args),
  writeLeaderboardMetricTrust: (...args: unknown[]) => mockWriteTrust(...args),
}))

import { publishTrustedLeaderboardSnapshotInTransaction } from '../publish'

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
  traderRows?: Array<{ exchange_trader_id: string; id: number }>
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
    if (sql.includes('FROM arena.sources')) {
      return {
        rows: [{ fetch_region: 'local', id: src.id, slug: src.slug, status: 'active' }],
        rowCount: 1,
      }
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
      const rows = options.traderRows ?? [{ id: 1_001, exchange_trader_id: row.exchangeTraderId }]
      return { rows, rowCount: rows.length }
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

  it('keeps the fenced v3 body query-only with source authority between its two locks', async () => {
    const harness = clientHarness()
    mockPrepareTrust.mockReturnValue(preparedV3)
    const sourceAuthorityGuard = jest.fn(async (transaction: PoolClient) => {
      await transaction.query(
        'SELECT source.id FROM arena.sources AS source WHERE source.id = $1::smallint FOR SHARE OF source',
        [src.id]
      )
    })

    await expect(
      publishTrustedLeaderboardSnapshotInTransaction(
        harness.client,
        trustedInput(),
        sourceAuthorityGuard
      )
    ).resolves.toEqual(
      expect.objectContaining({
        published: true,
        trust: expect.objectContaining({ replayed: false }),
      })
    )

    const statements = harness.query.mock.calls.map(([sql]) => String(sql))
    const publicationLockIndex = harness.query.mock.calls.findIndex(
      ([, params]) => (params as string[] | undefined)?.[0] === 'arena.publish-board-series:1'
    )
    const sourceAuthorityIndex = statements.findIndex((sql) => sql.includes('FROM arena.sources'))
    const baselineIndex = statements.findIndex((sql) => sql.includes('WITH observations AS'))
    const acquisitionLockIndex = harness.query.mock.calls.findIndex(
      ([, params]) =>
        (params as string[] | undefined)?.[0] === 'arena.leaderboard-acquisition-source:1:30'
    )
    const terminalCheckIndex = statements.findIndex((sql) =>
      sql.includes('arena.latest_terminal_leaderboard_acquisitions AS terminal')
    )
    expect(sourceAuthorityGuard).toHaveBeenCalledWith(harness.client)
    expect(publicationLockIndex).toBe(0)
    expect(sourceAuthorityIndex).toBe(publicationLockIndex + 1)
    expect(baselineIndex).toBeGreaterThan(sourceAuthorityIndex)
    expect(acquisitionLockIndex).toBeGreaterThan(baselineIndex)
    expect(terminalCheckIndex).toBe(acquisitionLockIndex + 1)
    expect(terminalCheckIndex).toBe(statements.length - 1)
    expect(statements.some((sql) => /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(sql.trim()))).toBe(
      false
    )
  })
})
