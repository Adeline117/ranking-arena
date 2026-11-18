const mockPoolQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: jest.fn(),
}))

import { ingestClientConnect } from '@/lib/ingest/db'
import {
  TRUST_EVIDENCE_RETENTION_DELETE_ENV,
  ensurePartitions,
  pruneLongTailHistories,
  retainTrustEvidence,
} from '../series'

describe('position-history maintenance retirement', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('never creates a child under the retired arena.position_history parent', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [{ ensure_month_partitions: 1 }] })

    await expect(ensurePartitions()).resolves.toBe(5)

    expect(mockPoolQuery.mock.calls.map(([, values]) => values?.[0])).toEqual([
      'leaderboard_entries',
      'trader_series',
      'order_records',
      'transfer_history',
      'copier_records',
    ])
    expect(JSON.stringify(mockPoolQuery.mock.calls)).not.toContain('position_history')
  })

  it('prunes mutable history surfaces without deleting retained position evidence', async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 5 })
      .mockResolvedValueOnce({ rowCount: 7 })

    await expect(pruneLongTailHistories(180)).resolves.toBe(15)

    const sql = mockPoolQuery.mock.calls.map(([statement]) => String(statement))
    expect(sql).toHaveLength(3)
    expect(sql[0]).toContain('DELETE FROM arena.order_records')
    expect(sql[1]).toContain('DELETE FROM arena.transfer_history')
    expect(sql[2]).toContain('DELETE FROM arena.copier_records')
    expect(sql.join('\n')).not.toContain('arena.position_history')
    expect(mockPoolQuery.mock.calls.every(([, values]) => values?.[0] === 180)).toBe(true)
  })
})

describe('trust evidence retention entrypoint', () => {
  const clientQuery = jest.fn()
  const release = jest.fn()

  function fakeClient(installed: boolean, deleteEnabled: boolean) {
    clientQuery.mockReset().mockImplementation(async (sql: string) => {
      if (sql.includes('to_regprocedure')) return { rows: [{ present: installed }] }
      if (sql.includes('SELECT delete_enabled')) {
        return { rows: [{ delete_enabled: deleteEnabled }] }
      }
      if (sql.includes('retain_trust_evidence')) {
        return { rows: [{ result: { mode: 'count', would_delete: { snapshots: 2 } } }] }
      }
      return { rows: [] }
    })
    release.mockReset()
    jest.mocked(ingestClientConnect).mockResolvedValue({
      query: clientQuery,
      release,
    } as unknown as Awaited<ReturnType<typeof ingestClientConnect>>)
  }

  const retentionCalls = () =>
    clientQuery.mock.calls.filter(([sql]) => String(sql).includes('retain_trust_evidence($1'))

  it('is a no-op before the migration is installed', async () => {
    fakeClient(false, false)
    await expect(retainTrustEvidence({})).resolves.toBe('not_installed')
    expect(retentionCalls()).toHaveLength(0)
  })

  it('counts only by default, inside a bounded transaction', async () => {
    fakeClient(true, true)
    const report = await retainTrustEvidence({})
    expect(report).toEqual({
      mode: 'count',
      delete_blocked_by: ['env'],
      result: { mode: 'count', would_delete: { snapshots: 2 } },
    })
    expect(retentionCalls()[0][1]).toEqual([false])
    const sql = clientQuery.mock.calls.map(([statement]) => String(statement))
    expect(sql).toEqual(
      expect.arrayContaining([
        'BEGIN',
        "SET LOCAL statement_timeout = '120s'",
        "SET LOCAL lock_timeout = '5s'",
        'COMMIT',
      ])
    )
  })

  it('stays count-only when only the env key is on', async () => {
    fakeClient(true, false)
    const report = await retainTrustEvidence({ [TRUST_EVIDENCE_RETENTION_DELETE_ENV]: '1' })
    expect(report).toMatchObject({ mode: 'count', delete_blocked_by: ['db_switch'] })
    expect(retentionCalls()[0][1]).toEqual([false])
  })

  it('requests delete mode only when both keys are on', async () => {
    fakeClient(true, true)
    const report = await retainTrustEvidence({ [TRUST_EVIDENCE_RETENTION_DELETE_ENV]: '1' })
    expect(report).toMatchObject({ mode: 'delete', delete_blocked_by: [] })
    expect(retentionCalls()[0][1]).toEqual([true])
  })
})
