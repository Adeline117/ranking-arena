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
}

function fakeDb({ installed = true, deleteEnabled = false, pages = [], claims = [] }: FakeDb) {
  const scanModes: boolean[] = []
  mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (sql.includes('to_regprocedure')) return { rows: [{ present: installed }] }
    if (sql.includes('SELECT delete_enabled')) return { rows: [{ delete_enabled: deleteEnabled }] }
    if (sql.includes('raw_retention_census')) return { rows: [{ census: { eligible_rows: 4 } }] }
    if (sql.includes('scan_raw_storage_orphans')) {
      scanModes.push(params?.[2] as boolean)
      return { rows: [{ result: pages.shift() ?? { page_objects: 0, pass_complete: true } }] }
    }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] }
    if (sql.includes('claim_raw_orphan_gc_batch')) {
      return { rows: (claims.shift() ?? []).map((storage_path) => ({ storage_path })) }
    }
    if (sql.includes('last_completed_orphan_pass')) return { rows: [{ pass: { orphans: 3 } }] }
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
      census: { eligible_rows: 4 },
      orphan_scan: { pages: 2, objects: 3, bytes: 35, orphans: 2, orphan_bytes: 15, enqueued: 0 },
      last_completed_orphan_pass: { orphans: 3 },
      orphan_gc_removed: 0,
      pointer_gc_removed: 0,
    })
    expect(scanModes).toEqual([false, false])
    expect(mockRemove).not.toHaveBeenCalled()
    expect(mockCleanup).not.toHaveBeenCalled()
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
