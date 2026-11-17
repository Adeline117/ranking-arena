import type { SourceRow } from '../../core/types'
import type { IngestQueryExecutor } from '../../db'
import { validateWorkerDbFencedWriteStatement } from '@/lib/ingest/db-fenced-write-contract'

const baselineQuery = jest.fn()
const clientQuery = jest.fn()
const release = jest.fn()

jest.mock('../../db', () => ({
  getIngestPool: () => ({ query: baselineQuery }),
  ingestClientConnect: jest.fn(async () => ({ query: clientQuery, release })),
}))

import {
  publishDerivedLeaderboardSnapshot,
  publishLeaderboardSnapshotInTransaction,
} from '../publish'

const src = {
  id: 19,
  slug: 'mexc_futures',
  currency: 'USDT',
  expected_count: 2_212,
  timeframes_native: [7],
  timeframes_derived: [30],
} as SourceRow

describe('publishLeaderboardSnapshot count baseline generation', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    baselineQuery.mockResolvedValue({ rows: [] })
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO arena.leaderboard_snapshots')) {
        return {
          rows: [{ id: 77, scraped_at: '2026-07-21 23:00:00.000000+00' }],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    })
  })

  it('resets to the new eligible-count bootstrap and persists its generation', async () => {
    const generation = 'derived-native-eligibility-v1'

    const result = await publishDerivedLeaderboardSnapshot({
      src,
      timeframe: 30,
      rows: [],
      rejects: [],
      expectedCountOverride: 300,
      countBaselineGeneration: generation,
    })

    expect(result.published).toBe(false)
    expect(result.verdict.baselineUsed).toBe(300)

    const baselineCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('WITH observations AS')
    )
    expect(baselineCall).toBeDefined()
    const [baselineSql, baselineParams] = baselineCall!
    expect(String(baselineSql)).toContain("meta->>'count_baseline_generation'")
    expect(baselineParams).toEqual([19, 30, 7, true, null, generation])
    expect(baselineQuery).not.toHaveBeenCalled()

    const snapshotCall = clientQuery.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO arena.leaderboard_snapshots')
    )
    expect(snapshotCall).toBeDefined()
    const snapshotParams = snapshotCall?.[1] as unknown[]
    expect(snapshotParams.slice(0, 9)).toEqual([19, 30, null, 300, 0, 300, false, true, null])
    expect(JSON.parse(String(snapshotParams[9]))).toEqual({
      count_baseline_generation: generation,
    })
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('rejects direct publication for a native or undeclared timeframe before DB I/O', async () => {
    await expect(
      publishDerivedLeaderboardSnapshot({
        src,
        timeframe: 7,
        rows: [],
        rejects: [],
      })
    ).rejects.toThrow('requires a declared derived-only timeframe')

    expect(clientQuery).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
  })

  it('runs the required source guard after the publication lock without transaction control', async () => {
    const fencedQuery = jest.fn((text: string, values?: readonly unknown[]) => {
      validateWorkerDbFencedWriteStatement(text)
      return clientQuery(text, values)
    })
    const transaction = { query: fencedQuery } as unknown as IngestQueryExecutor
    const sourceGuard = jest.fn(async (guardedTransaction: IngestQueryExecutor) => {
      expect(guardedTransaction).toBe(transaction)
      await guardedTransaction.query(
        'SELECT source.id FROM arena.sources AS source WHERE source.id = $1::smallint FOR SHARE OF source',
        [src.id]
      )
    })

    await expect(
      publishLeaderboardSnapshotInTransaction(
        transaction,
        {
          src,
          timeframe: 30,
          rows: [],
          rejects: [],
          rawObjectId: null,
          isDerived: true,
          expectedCountOverride: 300,
        },
        sourceGuard
      )
    ).resolves.toEqual(expect.objectContaining({ published: false, snapshotId: 77 }))

    const statements = fencedQuery.mock.calls.map(([sql]) => String(sql))
    const publicationLockIndex = fencedQuery.mock.calls.findIndex(
      ([, params]) => (params as string[] | undefined)?.[0] === 'arena.publish-board-series:19'
    )
    const sourceGuardIndex = statements.findIndex((sql) => sql.includes('FROM arena.sources'))
    const baselineIndex = statements.findIndex((sql) => sql.includes('WITH observations AS'))
    expect(publicationLockIndex).toBeGreaterThanOrEqual(0)
    expect(sourceGuardIndex).toBe(publicationLockIndex + 1)
    expect(baselineIndex).toBeGreaterThan(sourceGuardIndex)
    expect(statements.some((sql) => /^(?:BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(sql.trim()))).toBe(
      false
    )
    expect(statements.some((sql) => sql.includes('--'))).toBe(false)
    expect(fencedQuery).toHaveBeenCalledTimes(clientQuery.mock.calls.length)
    expect(release).not.toHaveBeenCalled()
  })

  describe('score-input evidence stamping', () => {
    const native = { ...src, timeframes_native: [30], timeframes_derived: [] } as SourceRow
    const row = {
      exchangeTraderId: 'trader-a',
      rank: 1,
      headlineRoi: 12,
      headlinePnl: 340,
      headlineWinRate: 55,
      headlineMdd: 8,
      raw: {},
    }
    const guard = jest.fn(async () => undefined)
    const runId = 'b'.repeat(64)

    function statsCall() {
      return clientQuery.mock.calls.find(([sql]) =>
        String(sql).includes('INSERT INTO arena.trader_stats')
      )
    }

    beforeEach(() => {
      clientQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('INSERT INTO arena.leaderboard_snapshots')) {
          return { rows: [{ id: 78, scraped_at: '2026-11-16 00:00:00.000000+00' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO arena.traders')) {
          return { rows: [{ id: 501, exchange_trader_id: 'trader-a' }], rowCount: 1 }
        }
        if (sql.includes('INSERT INTO arena.leaderboard_entries')) return { rows: [], rowCount: 1 }
        if (sql.includes('INSERT INTO arena.trader_stats')) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      })
    })

    it('stamps the board RAW and source run of an attempt-bound board write', async () => {
      await publishLeaderboardSnapshotInTransaction(
        { query: clientQuery } as unknown as IngestQueryExecutor,
        {
          src: native,
          timeframe: 30,
          rows: [row] as never,
          rejects: [],
          rawObjectId: 9001,
          expectedCountOverride: 1,
          statsEvidence: { rawObjectId: 9001, sourceRunId: runId },
        },
        guard
      )
      const params = statsCall()?.[1] as unknown[]
      expect(params.slice(5)).toEqual([9001, runId])
    })

    it('stamps nothing for a board write without an acquisition', async () => {
      await publishLeaderboardSnapshotInTransaction(
        { query: clientQuery } as unknown as IngestQueryExecutor,
        {
          src: native,
          timeframe: 30,
          rows: [row] as never,
          rejects: [],
          rawObjectId: 9001,
          expectedCountOverride: 1,
        },
        guard
      )
      const params = statsCall()?.[1] as unknown[]
      expect(params.slice(5)).toEqual([null, null])
    })

    it('refuses evidence that names a different RAW before any database I/O', async () => {
      await expect(
        publishLeaderboardSnapshotInTransaction(
          { query: clientQuery } as unknown as IngestQueryExecutor,
          {
            src: native,
            timeframe: 30,
            rows: [row] as never,
            rejects: [],
            rawObjectId: 9001,
            expectedCountOverride: 1,
            statsEvidence: { rawObjectId: 9002, sourceRunId: runId },
          },
          guard
        )
      ).rejects.toThrow('stats evidence must name the snapshot RAW')
      expect(clientQuery).not.toHaveBeenCalled()
    })
  })
})
