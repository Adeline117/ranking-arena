const mockPoolQuery = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  getIngestPool: jest.fn(() => ({ query: mockPoolQuery })),
  ingestClientConnect: jest.fn(),
}))

import { ingestClientConnect } from '@/lib/ingest/db'
import {
  TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP,
  TRUST_EVIDENCE_RETENTION_DELETE_ENV,
  TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP,
  TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY,
  ensurePartitions,
  nextTrustEvidenceRowCap,
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

  function memoryStore(initial?: string) {
    const values = new Map<string, string>()
    if (initial !== undefined) values.set(TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY, initial)
    return {
      values,
      get: async (key: string) => values.get(key) ?? null,
      set: async (key: string, value: string) => values.set(key, value),
    }
  }

  function fakeClient(
    installed: boolean,
    deleteEnabled: boolean,
    retain: (params: unknown[]) => Promise<unknown> = async () => ({
      rows: [{ result: { mode: 'count', would_delete: { rows_in_scope: 2 } } }],
    })
  ) {
    clientQuery.mockReset().mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('to_regprocedure')) return { rows: [{ present: installed }] }
      if (sql.includes('SELECT delete_enabled')) {
        return { rows: [{ delete_enabled: deleteEnabled }] }
      }
      if (sql.includes('retain_trust_evidence($1')) return retain(params ?? [])
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
  const timeout = () =>
    Object.assign(new Error('canceling statement due to statement timeout'), {
      code: '57014',
    })

  it('is a no-op before the migration is installed', async () => {
    fakeClient(false, false)
    await expect(retainTrustEvidence({ env: {}, rowCapStore: memoryStore() })).resolves.toBe(
      'not_installed'
    )
    expect(retentionCalls()).toHaveLength(0)
  })

  it('counts only by default, inside a bounded transaction, without touching the row cap', async () => {
    fakeClient(true, true)
    const store = memoryStore()
    const report = await retainTrustEvidence({ env: {}, rowCapStore: store })
    expect(report).toEqual({
      mode: 'count',
      delete_blocked_by: ['env'],
      row_cap: TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP,
      next_row_cap: TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP,
      result: { mode: 'count', would_delete: { rows_in_scope: 2 } },
    })
    expect(retentionCalls()[0][1]).toEqual([false, TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP])
    expect(store.values.size).toBe(0)
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
    const report = await retainTrustEvidence({
      env: { [TRUST_EVIDENCE_RETENTION_DELETE_ENV]: '1' },
      rowCapStore: memoryStore(),
    })
    expect(report).toMatchObject({ mode: 'count', delete_blocked_by: ['db_switch'] })
    expect(retentionCalls()[0][1][0]).toBe(false)
  })

  it('requests delete mode only when both keys are on', async () => {
    fakeClient(true, true)
    const report = await retainTrustEvidence({
      env: { [TRUST_EVIDENCE_RETENTION_DELETE_ENV]: '1' },
      rowCapStore: memoryStore(),
    })
    expect(report).toMatchObject({ mode: 'delete', delete_blocked_by: [] })
    expect(retentionCalls()[0][1][0]).toBe(true)
  })

  it('halves the row cap after a timed-out batch and keeps shrinking until a batch fits', async () => {
    const store = memoryStore()
    const env = { [TRUST_EVIDENCE_RETENTION_DELETE_ENV]: '1' }
    const attempted: number[] = []
    // Batches above 20,000 rows time out (one huge snapshot); smaller ones fit.
    fakeClient(true, true, async (params) => {
      const cap = params[1] as number
      attempted.push(cap)
      if (cap > 20_000) throw timeout()
      return { rows: [{ result: { mode: 'delete', deleted: { rows: cap } } }] }
    })

    for (let run = 0; run < 3; run += 1) {
      await expect(retainTrustEvidence({ env, rowCapStore: store })).rejects.toThrow(
        /timed out and rolled back; next run uses/
      )
      const sql = clientQuery.mock.calls.map(([statement]) => String(statement))
      expect(sql).toContain('ROLLBACK')
      expect(sql).not.toContain('COMMIT')
    }
    const report = await retainTrustEvidence({ env, rowCapStore: store })
    expect(attempted).toEqual([100_000, 50_000, 25_000, 12_500])
    expect(report).toMatchObject({ mode: 'delete', row_cap: 12_500, next_row_cap: 25_000 })
    expect(store.values.get(TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY)).toBe('25000')
  })

  it('never shrinks below the floor, and passes other errors through unchanged', async () => {
    expect(nextTrustEvidenceRowCap(1_500, true)).toBe(TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP)
    expect(nextTrustEvidenceRowCap(TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP, true)).toBe(
      TRUST_EVIDENCE_RETENTION_MIN_ROW_CAP
    )
    expect(nextTrustEvidenceRowCap(80_000, false)).toBe(TRUST_EVIDENCE_RETENTION_DEFAULT_ROW_CAP)

    const store = memoryStore('4000')
    fakeClient(true, true, async () => {
      throw Object.assign(new Error('switch is off'), { code: '55000' })
    })
    await expect(
      retainTrustEvidence({
        env: { [TRUST_EVIDENCE_RETENTION_DELETE_ENV]: '1' },
        rowCapStore: store,
      })
    ).rejects.toThrow('switch is off')
    expect(store.values.get(TRUST_EVIDENCE_RETENTION_ROW_CAP_KEY)).toBe('4000')
  })
})
