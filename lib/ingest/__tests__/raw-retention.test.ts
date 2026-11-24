/**
 * @jest-environment node
 */
const mockQuery = jest.fn()
const mockRelease = jest.fn()
const mockCleanup = jest.fn()
const mockRemove = jest.fn()

jest.mock('@/lib/ingest/db', () => ({
  ingestClientConnect: jest.fn(async () => ({ query: mockQuery, release: mockRelease })),
}))
jest.mock('@/lib/ingest/raw', () => ({
  cleanupRawObjects: (...args: unknown[]) => mockCleanup(...args),
  removeRawStorageObjects: (...args: unknown[]) => mockRemove(...args),
}))

import { RAW_RETENTION_DELETE_ENV, runRawRetention } from '@/lib/ingest/raw-retention'

interface FakeDb {
  installed?: boolean
  deleteEnabled?: boolean
  pages?: Array<Record<string, unknown>>
  claims?: string[][]
  estimate?: { rows: number | null; bytes: number | null }
}

function fakeDb({
  installed = true,
  deleteEnabled = false,
  pages = [],
  claims = [],
  estimate = { rows: 5_560_000, bytes: 2_800_000_000 },
}: FakeDb) {
  const scanModes: boolean[] = []
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('to_regprocedure')) return { rows: [{ present: installed }] }
    if (sql.includes('SELECT delete_enabled')) return { rows: [{ delete_enabled: deleteEnabled }] }
    if (sql.includes('pg_total_relation_size')) {
      return { rows: [{ rows_estimate: estimate.rows, relation_bytes: estimate.bytes }] }
    }
    if (sql.includes('AS gc_queue_rows')) {
      return {
        rows: [
          {
            gc_queue_rows: 7,
            gc_queue_failed_rows: 1,
            orphan_queue_rows: 3,
            orphan_queue_failed_rows: 0,
          },
        ],
      }
    }
    if (sql.includes('scan_raw_pointer_retention')) {
      return {
        rows: [
          {
            result: {
              page_rows: 6,
              page_expired_rows: 4,
              page_snapshot_pinned_rows: 1,
              page_trust_pinned_rows: 2,
              page_eligible_rows: 1,
              page_eligible_bytes: 400,
              pass_complete: true,
            },
          },
        ],
      }
    }
    if (sql.includes('scan_raw_storage_orphans')) {
      scanModes.push(params?.[2] as boolean)
      return { rows: [{ result: pages.shift() ?? { page_objects: 0, pass_complete: true } }] }
    }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
    if (sql.includes('claim_raw_orphan_gc_batch')) {
      return { rows: (claims.shift() ?? []).map((storage_path) => ({ storage_path })) }
    }
    if (sql.includes('last_completed_orphan_pass')) {
      return {
        rows: [
          {
            pointer_pass: { eligible_rows: 1 },
            orphan_pass: { orphans: 3 },
            pointer_progress: { cursor_after_id: 5000, rows: 5000, expired_rows: 40 },
            orphan_progress: { cursor_after_name: 'b/o3.json.gz', objects: 3 },
          },
        ],
      }
    }
    return { rows: [], rowCount: 0 }
  })
  return scanModes
}

beforeEach(() => {
  mockQuery.mockReset()
  mockRelease.mockReset()
  mockCleanup.mockReset()
  mockRemove.mockReset().mockResolvedValue({ error: null })
})

describe('runRawRetention', () => {
  it('reports not_installed before the migration exists', async () => {
    fakeDb({ installed: false })
    await expect(runRawRetention({ env: {} })).resolves.toBe('not_installed')
    expect(mockRelease).toHaveBeenCalledWith(false)
  })

  it('counts only by default: no enqueue, no Storage removal, no extra pointer GC', async () => {
    const scanModes = fakeDb({
      deleteEnabled: true,
      pages: [
        { page_objects: 2, page_bytes: 30, page_orphans: 1, page_orphan_bytes: 10, enqueued: 0 },
        {
          page_objects: 1,
          page_bytes: 5,
          page_orphans: 1,
          page_orphan_bytes: 5,
          pass_complete: true,
        },
      ],
    })
    const report = await runRawRetention({ env: {}, scanPageSize: 2 })
    expect(report).toMatchObject({
      mode: 'count',
      delete_blocked_by: ['env'],
      census: {
        contract: 'arena.raw-retention-census@3',
        estimated: true,
        pointer_rows_estimate: 5_560_000,
        pointer_relation_bytes: 2_800_000_000,
        gc_queue_rows: 7,
        gc_queue_failed_rows: 1,
        orphan_queue_rows: 3,
        orphan_queue_failed_rows: 0,
        delete_enabled: true,
      },
      pointer_scan: { pages: 1, rows: 6, expired_rows: 4, eligible_rows: 1, eligible_bytes: 400 },
      pointer_pass_progress: { cursor_after_id: 5000, rows: 5000, expired_rows: 40 },
      last_completed_pointer_pass: { eligible_rows: 1 },
      orphan_pass_progress: { cursor_after_name: 'b/o3.json.gz', objects: 3 },
      orphan_scan: { pages: 2, objects: 3, bytes: 35, orphans: 2, orphan_bytes: 15, enqueued: 0 },
      last_completed_orphan_pass: { orphans: 3 },
      orphan_gc_removed: 0,
      pointer_gc_removed: 0,
    })
    expect(scanModes).toEqual([false, false])
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
    expect(mockQuery).toHaveBeenCalledWith("SET statement_timeout = '60s'")
  })

  it('never calls the whole-table census function or aggregates arena.raw_objects', async () => {
    fakeDb({})
    await runRawRetention({ env: {} })
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => sql.includes('raw_retention_census'))).toBe(false)
    expect(sqls.some((sql) => /FROM\s+arena\.raw_objects/i.test(sql))).toBe(false)
    expect(sqls.some((sql) => sql.includes('pg_class') && sql.includes('reltuples'))).toBe(true)
  })

  it('reports a never-analyzed pointer table as an unknown estimate, not a negative count', async () => {
    fakeDb({ estimate: { rows: -1, bytes: 8192 } })
    const report = await runRawRetention({ env: {} })
    expect(report).toMatchObject({
      census: { estimated: true, pointer_rows_estimate: null, pointer_relation_bytes: 8192 },
    })
  })

  it('stays count-only when the env key is on but the database switch is off', async () => {
    fakeDb({ deleteEnabled: false })
    const report = await runRawRetention({ env: { [RAW_RETENTION_DELETE_ENV]: '1' } })
    expect(report).toMatchObject({ mode: 'count', delete_blocked_by: ['db_switch'] })
    expect(mockRemove).not.toHaveBeenCalled()
  })

  it('with both keys on, enqueues, drains the orphan queue and runs extra pointer GC', async () => {
    const scanModes = fakeDb({
      deleteEnabled: true,
      pages: [{ page_objects: 1, page_orphans: 1, enqueued: 1, pass_complete: true }],
      claims: [['b/o1.json.gz', 'b/o3.json.gz']],
    })
    mockCleanup.mockResolvedValueOnce(500).mockResolvedValueOnce(0)
    const report = await runRawRetention({ env: { [RAW_RETENTION_DELETE_ENV]: '1' } })
    expect(report).toMatchObject({ mode: 'delete', orphan_gc_removed: 2, pointer_gc_removed: 500 })
    expect(scanModes).toEqual([true])
    expect(mockRemove).toHaveBeenCalledWith(['b/o1.json.gz', 'b/o3.json.gz'])
    expect(mockCleanup).toHaveBeenCalledTimes(2)
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => sql.startsWith('DELETE FROM arena.raw_orphan_gc_queue'))).toBe(true)
  })

  it('keeps the queue rows and fails when Storage removal fails', async () => {
    fakeDb({ deleteEnabled: true, claims: [['b/o1.json.gz']] })
    mockRemove.mockResolvedValue({ error: 'storage down' })
    await expect(runRawRetention({ env: { [RAW_RETENTION_DELETE_ENV]: '1' } })).rejects.toThrow(
      'orphan Storage removal failed'
    )
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls.some((sql) => sql.includes('SET attempts = attempts + 1'))).toBe(true)
    expect(sqls.some((sql) => sql.startsWith('DELETE FROM arena.raw_orphan_gc_queue'))).toBe(false)
    expect(mockRelease).toHaveBeenCalledWith(true)
  })
})
