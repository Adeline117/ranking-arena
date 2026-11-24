/**
 * @jest-environment node
 */
const mockQuery = jest.fn()
const mockRelease = jest.fn()
const mockCleanup = jest.fn()
const mockRemove = jest.fn()

const mockConnect = jest.fn(async () => ({ query: mockQuery, release: mockRelease }))
jest.mock('@/lib/ingest/db', () => ({
  ingestClientConnect: () => mockConnect(),
}))
jest.mock('@/lib/ingest/raw', () => ({
  cleanupRawObjects: (...args: unknown[]) => mockCleanup(...args),
  removeRawStorageObjects: (...args: unknown[]) => mockRemove(...args),
}))

import {
  RAW_RETENTION_DEADLINE_MS,
  RAW_RETENTION_DELETE_ENV,
  RAW_RETENTION_MAX_SCAN_PAGES,
  RAW_RETENTION_SCAN_PAGE_BOUNDS,
  RAW_RETENTION_SCAN_PAGE_SIZE,
  RAW_RETENTION_SWITCH_ENV,
  runRawRetention,
} from '@/lib/ingest/raw-retention'

interface FakeDb {
  installed?: boolean
  deleteEnabled?: boolean
  pages?: Array<Record<string, unknown>>
  claims?: string[][]
  estimate?: { rows: number | null; bytes: number | null }
  pointerPage?: Record<string, unknown>
  endlessOrphanPages?: boolean
}

function fakeDb({
  installed = true,
  deleteEnabled = false,
  pages = [],
  claims = [],
  estimate = { rows: 5_560_000, bytes: 2_800_000_000 },
  pointerPage = {
    page_rows: 6,
    page_expired_rows: 4,
    page_snapshot_pinned_rows: 1,
    page_trust_pinned_rows: 2,
    page_eligible_rows: 1,
    page_eligible_bytes: 400,
    pass_complete: true,
  },
  endlessOrphanPages = false,
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
      return { rows: [{ result: pointerPage }] }
    }
    if (sql.includes('scan_raw_storage_orphans')) {
      scanModes.push(params?.[2] as boolean)
      const fallback = endlessOrphanPages
        ? { page_objects: 5000, pass_complete: false }
        : { page_objects: 0, pass_complete: true }
      return { rows: [{ result: pages.shift() ?? fallback }] }
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
  mockConnect.mockClear()
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

  it.each(['off', 'OFF', ' Off '])(
    'INGEST_RAW_RETENTION=%s skips the step without connecting to the database',
    async (value) => {
      fakeDb({})
      const log = jest.spyOn(console, 'warn').mockImplementation(() => {})
      await expect(runRawRetention({ env: { [RAW_RETENTION_SWITCH_ENV]: value } })).resolves.toBe(
        'disabled'
      )
      expect(mockConnect).not.toHaveBeenCalled()
      expect(mockQuery).not.toHaveBeenCalled()
      expect(log).toHaveBeenCalledWith('[raw-retention] skipped: INGEST_RAW_RETENTION=off')
      log.mockRestore()
    }
  )

  it.each([undefined, '', 'on', '0'])('INGEST_RAW_RETENTION=%s still runs', async (value) => {
    fakeDb({})
    const report = await runRawRetention({ env: { [RAW_RETENTION_SWITCH_ENV]: value } })
    expect(report).toMatchObject({ mode: 'count' })
    expect(mockConnect).toHaveBeenCalledTimes(1)
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

  it('bounds every statement to 15s before running anything else', async () => {
    fakeDb({})
    await runRawRetention({ env: {} })
    const sqls = mockQuery.mock.calls.map(([sql]) => String(sql))
    expect(sqls[0]).toBe("SET statement_timeout = '15s'")
    expect(sqls.filter((sql) => sql.startsWith('SET statement_timeout'))).toHaveLength(1)
    expect(sqls[sqls.length - 1]).toBe('RESET statement_timeout')
  })

  it('scans in pages of 5,000 by default, for both walks', async () => {
    fakeDb({})
    await runRawRetention({ env: {} })
    const pageSizes = mockQuery.mock.calls
      .filter(([sql]) =>
        /SELECT arena\.scan_raw_(pointer_retention|storage_orphans)/.test(String(sql))
      )
      .map(([, params]) => (params as unknown[])[0])
    expect(pageSizes).toEqual([5000, 5000])
    expect(RAW_RETENTION_SCAN_PAGE_SIZE).toBeGreaterThanOrEqual(RAW_RETENTION_SCAN_PAGE_BOUNDS.min)
    expect(RAW_RETENTION_DEADLINE_MS).toBe(60_000)
  })

  it('never asks for a page below the database minimum', async () => {
    fakeDb({})
    await runRawRetention({ env: {}, scanPageSize: 0 })
    const pageSizes = mockQuery.mock.calls
      .filter(([sql]) =>
        /SELECT arena\.scan_raw_(pointer_retention|storage_orphans)/.test(String(sql))
      )
      .map(([, params]) => (params as unknown[])[0])
    expect(pageSizes).toEqual([1, 1])
  })

  it('stops paging when the time budget is spent', async () => {
    // Never-ending passes: every page is full. Each page costs 10s of fake time.
    let clock = 0
    fakeDb({ pointerPage: { page_rows: 5000, pass_complete: false }, endlessOrphanPages: true })
    mockQuery.mockImplementation(
      ((inner) => async (sql: string, params?: unknown[]) => {
        if (/SELECT arena\.scan_raw_(pointer_retention|storage_orphans)/.test(sql)) clock += 10_000
        return inner(sql, params)
      })(mockQuery.getMockImplementation() as (sql: string, params?: unknown[]) => Promise<unknown>)
    )
    const report = await runRawRetention({ env: {}, now: () => clock })
    // 60s budget: the pointer walk gets the first 30s (3 pages), the orphan walk the rest (3 pages).
    expect(report).toMatchObject({
      pointer_scan: { pages: 3, rows: 15_000, pass_complete: false },
      orphan_scan: { pages: 3, pass_complete: false },
      stopped_by_deadline: true,
    })
  })

  it('caps pages per walk even when the clock never moves', async () => {
    fakeDb({ pointerPage: { page_rows: 5000, pass_complete: false }, endlessOrphanPages: true })
    const report = await runRawRetention({ env: {}, now: () => 0 })
    expect(report).toMatchObject({
      pointer_scan: { pages: RAW_RETENTION_MAX_SCAN_PAGES },
      orphan_scan: { pages: RAW_RETENTION_MAX_SCAN_PAGES },
      stopped_by_deadline: false,
    })
  })

  describe('a scan page that times out', () => {
    const pgError = (code: string, message: string) => Object.assign(new Error(message), { code })
    const failScan = (
      fn: 'scan_raw_pointer_retention' | 'scan_raw_storage_orphans',
      err: Error
    ) => {
      const inner = mockQuery.getMockImplementation() as (
        sql: string,
        params?: unknown[]
      ) => Promise<unknown>
      let calls = 0
      mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes(`SELECT arena.${fn}(`)) {
          calls += 1
          // Page 1 succeeds, page 2 fails.
          if (calls === 2) throw err
        }
        return inner(sql, params)
      })
    }
    const scanCalls = (fn: string) =>
      mockQuery.mock.calls.filter(([sql]) => String(sql).includes(`SELECT arena.${fn}(`)).length

    beforeEach(() => jest.spyOn(console, 'warn').mockImplementation(() => {}))
    afterEach(() => jest.restoreAllMocks())

    it.each([
      ['57014', 'canceling statement due to statement timeout'],
      ['55P03', 'canceling statement due to lock timeout'],
    ])(
      'pointer page SQLSTATE %s: returns a report, keeps the cursor, ends the run',
      async (code, msg) => {
        fakeDb({
          deleteEnabled: true,
          pointerPage: { page_rows: 5000, page_expired_rows: 9, pass_complete: false },
        })
        failScan('scan_raw_pointer_retention', pgError(code, msg))
        const report = await runRawRetention({ env: { [RAW_RETENTION_DELETE_ENV]: '1' } })
        expect(report).toMatchObject({
          mode: 'delete',
          stopped_on_timeout: true,
          stopped_on: { scan: 'pointer', sqlstate: code },
          // Only the page that committed is counted; the failed page is not.
          pointer_scan: { pages: 1, rows: 5000, expired_rows: 9, pass_complete: false },
          orphan_scan: { pages: 0 },
          pointer_pass_progress: { cursor_after_id: 5000 },
          orphan_gc_removed: 0,
          pointer_gc_removed: 0,
        })
        // The failed page is not retried and nothing else walks or deletes this run.
        expect(scanCalls('scan_raw_pointer_retention')).toBe(2)
        expect(scanCalls('scan_raw_storage_orphans')).toBe(0)
        expect(mockRemove).not.toHaveBeenCalled()
        expect(mockCleanup).not.toHaveBeenCalled()
        // The connection is healthy after a cancelled statement: reset and returned to the pool.
        expect(mockRelease).toHaveBeenCalledTimes(1)
        expect(mockRelease).toHaveBeenCalledWith(false)
      }
    )

    it('orphan page timeout: returns a report with what the earlier pages counted', async () => {
      fakeDb({ endlessOrphanPages: true })
      failScan(
        'scan_raw_storage_orphans',
        pgError('57014', 'canceling statement due to statement timeout')
      )
      const report = await runRawRetention({ env: {} })
      expect(report).toMatchObject({
        stopped_on_timeout: true,
        stopped_on: { scan: 'orphan', sqlstate: '57014' },
        pointer_scan: { pages: 1, pass_complete: true },
        orphan_scan: { pages: 1, objects: 5000, pass_complete: false },
      })
      expect(scanCalls('scan_raw_storage_orphans')).toBe(2)
    })

    it('any other page error still fails the step and discards the connection', async () => {
      fakeDb({ pointerPage: { page_rows: 5000, pass_complete: false } })
      failScan('scan_raw_pointer_retention', pgError('42501', 'permission denied'))
      await expect(runRawRetention({ env: {} })).rejects.toThrow('permission denied')
      expect(mockRelease).toHaveBeenCalledTimes(1)
      expect(mockRelease).toHaveBeenCalledWith(true)
    })

    it('a timeout outside the paged scans is not swallowed', async () => {
      fakeDb({})
      const inner = mockQuery.getMockImplementation() as (sql: string) => Promise<unknown>
      mockQuery.mockImplementation(async (sql: string) => {
        if (sql.includes('AS gc_queue_rows')) throw pgError('57014', 'canceling statement')
        return inner(sql)
      })
      await expect(runRawRetention({ env: {} })).rejects.toThrow('canceling statement')
      expect(mockRelease).toHaveBeenCalledWith(true)
    })
  })

  it('reports no timeout stop on a normal run', async () => {
    fakeDb({})
    await expect(runRawRetention({ env: {} })).resolves.toMatchObject({
      stopped_on_timeout: false,
      stopped_on: null,
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
