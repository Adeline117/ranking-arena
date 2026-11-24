/**
 * RAW retention backlog (20261118134316). Runs from the worker maintenance
 * job right after the routine single-batch cleanupRawObjects(30).
 *
 * Count-only by default. Every run reports a cheap census (planner-statistics
 * estimate of the pointer table, exact depths of the two small queues), then
 * walks bounded id pages of arena.raw_objects (expired / pinned / eligible) and
 * bounded name pages of the raw-snapshots bucket looking for objects that have
 * no arena.raw_objects pointer (they can never enter arena.raw_object_gc_queue).
 * No statement joins the two large tables wholesale; each runs under a 60s
 * statement_timeout. Storage objects are only removed through the Storage API
 * (supabase.storage.from(bucket).remove), never by deleting storage.objects rows.
 *
 * INGEST_RAW_RETENTION=off (case-insensitive) skips the whole step before any
 * database connection is taken; unset runs it.
 *
 * Deletion needs BOTH keys:
 *   - worker env INGEST_RAW_RETENTION_DELETE=1, and
 *   - arena.raw_retention_settings.delete_enabled = true (owner-only).
 * With both on, the run additionally queues old orphans, drains the orphan
 * queue through the Storage API, and runs extra pointer GC batches so the
 * backlog can shrink faster than 500 objects per 6h. Objects are only ever
 * removed from a durable queue row; nothing here decides garbage on its own.
 */

import type { PoolClient } from 'pg'
import { ingestClientConnect } from './db'
import { cleanupRawObjects, removeRawStorageObjects } from './raw'

export const RAW_RETENTION_DELETE_ENV = 'INGEST_RAW_RETENTION_DELETE'
/** Kill switch: `off` (any case) skips the whole step without a release. Unset = run. */
export const RAW_RETENTION_SWITCH_ENV = 'INGEST_RAW_RETENTION'
const ORPHAN_GC_ADVISORY_LOCK = "pg_catalog.hashtextextended('arena.raw_orphan_gc_queue', 0)"
const ORPHAN_GC_BATCH = 500

export interface RawRetentionOptions {
  retentionDays?: number
  scanPageSize?: number
  maxScanPages?: number
  maxPointerBatches?: number
  maxOrphanBatches?: number
  deadlineMs?: number
  env?: Record<string, string | undefined>
  now?: () => number
}

export interface RawOrphanScanTally {
  pages: number
  objects: number
  bytes: number
  orphans: number
  orphan_bytes: number
  enqueued: number
  pass_complete: boolean
  skipped: string | null
}

export interface RawPointerScanTally {
  pages: number
  rows: number
  expired_rows: number
  snapshot_pinned_rows: number
  trust_pinned_rows: number
  eligible_rows: number
  eligible_bytes: number
  pass_complete: boolean
}

export interface RawRetentionReport {
  contract: 'arena.raw-retention-run@1'
  mode: 'count' | 'delete'
  delete_blocked_by: Array<'env' | 'db_switch'>
  census: RawRetentionCensus
  pointer_scan: RawPointerScanTally
  /** Running totals of the pass in progress: where the cursor is and what it has counted so far. */
  pointer_pass_progress: Record<string, unknown> | null
  last_completed_pointer_pass: Record<string, unknown> | null
  orphan_scan: RawOrphanScanTally
  orphan_pass_progress: Record<string, unknown> | null
  last_completed_orphan_pass: Record<string, unknown> | null
  orphan_gc_removed: number
  pointer_gc_removed: number
  stopped_by_deadline: boolean
}

interface PointerPageResult {
  page_rows?: number
  page_expired_rows?: number
  page_snapshot_pinned_rows?: number
  page_trust_pinned_rows?: number
  page_eligible_rows?: number
  page_eligible_bytes?: number
  pass_complete?: boolean
}

interface ScanPageResult {
  page_objects?: number
  page_bytes?: number
  page_orphans?: number
  page_orphan_bytes?: number
  enqueued?: number
  pass_complete?: boolean
  skipped?: string
}

/**
 * Cheap census. arena.raw_retention_census (20261118134316) aggregates the
 * whole of arena.raw_objects in one statement (~5.6M rows, a ~2.9GB sequential
 * scan in production) and never finished inside the statement timeout, so the
 * worker no longer calls it; the function stays in the database unused.
 * Totals come from planner statistics and the relation size instead, and are
 * ESTIMATES. Expired rows / bytes are not computed here at all: they accumulate
 * page by page in the resumable pointer scan (see pointer_pass_progress).
 */
export interface RawRetentionCensus {
  contract: 'arena.raw-retention-census@3'
  estimated: true
  /** pg_class.reltuples as of the last ANALYZE/VACUUM; null when never analyzed. */
  pointer_rows_estimate: number | null
  /** pg_total_relation_size: heap + indexes + TOAST on disk, NOT stored object bytes. */
  pointer_relation_bytes: number | null
  gc_queue_rows: number
  gc_queue_failed_rows: number
  orphan_queue_rows: number
  orphan_queue_failed_rows: number
  delete_enabled: boolean
}

export const RAW_POINTER_ESTIMATE_SQL = `SELECT relation.reltuples::bigint AS rows_estimate,
        pg_catalog.pg_total_relation_size(relation.oid) AS relation_bytes
   FROM pg_catalog.pg_class AS relation
  WHERE relation.oid = pg_catalog.to_regclass('arena.raw_objects')`

export const RAW_QUEUE_DEPTHS_SQL = `SELECT
  (SELECT pg_catalog.count(*) FROM arena.raw_object_gc_queue) AS gc_queue_rows,
  (SELECT pg_catalog.count(*) FROM arena.raw_object_gc_queue WHERE attempts > 0)
    AS gc_queue_failed_rows,
  (SELECT pg_catalog.count(*) FROM arena.raw_orphan_gc_queue) AS orphan_queue_rows,
  (SELECT pg_catalog.count(*) FROM arena.raw_orphan_gc_queue WHERE attempts > 0)
    AS orphan_queue_failed_rows`

/** Cursor position and running tallies of the passes in progress, plus the last finished ones. */
export const RAW_PASS_PROGRESS_SQL = `SELECT last_completed_pointer_pass AS pointer_pass,
        last_completed_orphan_pass AS orphan_pass,
        pg_catalog.jsonb_build_object(
          'cursor_after_id', pointer_scan_after,
          'started_at', pointer_pass_started_at,
          'rows', pointer_pass_rows,
          'expired_rows', pointer_pass_expired_rows,
          'snapshot_pinned_rows', pointer_pass_snapshot_pinned_rows,
          'trust_pinned_rows', pointer_pass_trust_pinned_rows,
          'eligible_rows', pointer_pass_eligible_rows,
          'eligible_bytes', pointer_pass_eligible_bytes
        ) AS pointer_progress,
        pg_catalog.jsonb_build_object(
          'cursor_after_name', orphan_scan_after,
          'started_at', orphan_pass_started_at,
          'objects', orphan_pass_objects,
          'bytes', orphan_pass_bytes,
          'orphans', orphan_pass_orphans,
          'orphan_bytes', orphan_pass_orphan_bytes
        ) AS orphan_progress
   FROM arena.raw_retention_settings WHERE singleton`

const asNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

async function readCheapCensus(
  client: PoolClient,
  deleteEnabled: boolean
): Promise<RawRetentionCensus> {
  const { rows: estimateRows } = await client.query<{
    rows_estimate: number | null
    relation_bytes: number | null
  }>(RAW_POINTER_ESTIMATE_SQL)
  const { rows: queueRows } = await client.query<Record<string, unknown>>(RAW_QUEUE_DEPTHS_SQL)
  const estimate = estimateRows[0]
  const queues = queueRows[0] ?? {}
  // reltuples is -1 until the table has been analyzed or vacuumed once.
  const rowsEstimate = estimate?.rows_estimate == null ? -1 : asNumber(estimate.rows_estimate)
  return {
    contract: 'arena.raw-retention-census@3',
    estimated: true,
    pointer_rows_estimate: rowsEstimate < 0 ? null : rowsEstimate,
    pointer_relation_bytes:
      estimate?.relation_bytes == null ? null : asNumber(estimate.relation_bytes),
    gc_queue_rows: asNumber(queues.gc_queue_rows),
    gc_queue_failed_rows: asNumber(queues.gc_queue_failed_rows),
    orphan_queue_rows: asNumber(queues.orphan_queue_rows),
    orphan_queue_failed_rows: asNumber(queues.orphan_queue_failed_rows),
    delete_enabled: deleteEnabled,
  }
}

async function drainOrphanQueue(
  client: PoolClient,
  maxBatches: number,
  pastDeadline: () => boolean
): Promise<number> {
  const { rows: lockRows } = await client.query<{ acquired: boolean }>(
    `SELECT pg_catalog.pg_try_advisory_lock(${ORPHAN_GC_ADVISORY_LOCK}) AS acquired`
  )
  if (lockRows[0]?.acquired !== true) return 0
  let removed = 0
  try {
    for (let batch = 0; batch < maxBatches && !pastDeadline(); batch += 1) {
      const { rows } = await client.query<{ storage_path: string }>(
        `SELECT storage_path FROM arena.claim_raw_orphan_gc_batch($1::integer)`,
        [ORPHAN_GC_BATCH]
      )
      if (rows.length === 0) break
      const paths = rows.map((row) => row.storage_path)
      const { error } = await removeRawStorageObjects(paths)
      if (error) {
        await client.query(
          `UPDATE arena.raw_orphan_gc_queue
              SET attempts = attempts + 1, last_attempt_at = now(), last_error = $2
            WHERE storage_path = ANY($1::text[])`,
          [paths, error.slice(0, 2_000)]
        )
        throw new Error(`[raw-retention] orphan Storage removal failed; queue retained: ${error}`)
      }
      await client.query(
        `DELETE FROM arena.raw_orphan_gc_queue WHERE storage_path = ANY($1::text[])`,
        [paths]
      )
      removed += paths.length
    }
  } finally {
    await client.query(`SELECT pg_catalog.pg_advisory_unlock(${ORPHAN_GC_ADVISORY_LOCK})`)
  }
  return removed
}

export async function runRawRetention(
  options: RawRetentionOptions = {}
): Promise<RawRetentionReport | 'not_installed' | 'disabled'> {
  const retentionDays = options.retentionDays ?? 30
  const scanPageSize = options.scanPageSize ?? 50_000
  const maxScanPages = options.maxScanPages ?? 20
  const maxPointerBatches = options.maxPointerBatches ?? 40
  const maxOrphanBatches = options.maxOrphanBatches ?? 40
  const now = options.now ?? Date.now
  const deadline = now() + (options.deadlineMs ?? 20 * 60_000)
  const pastDeadline = () => now() >= deadline
  const env = options.env ?? process.env

  if (env[RAW_RETENTION_SWITCH_ENV]?.trim().toLowerCase() === 'off') {
    console.warn(`[raw-retention] skipped: ${RAW_RETENTION_SWITCH_ENV}=off`)
    return 'disabled'
  }

  const client = await ingestClientConnect()
  let destroyClient = false
  let report: RawRetentionReport
  try {
    const { rows: installed } = await client.query<{ present: boolean }>(
      `SELECT pg_catalog.to_regprocedure(
                'arena.scan_raw_storage_orphans(integer,integer,boolean)'
              ) IS NOT NULL AS present`
    )
    if (installed[0]?.present !== true) return 'not_installed'

    // Every statement below is one bounded page or a single-table aggregate;
    // the database functions refuse to run without this bound.
    await client.query(`SET statement_timeout = '60s'`)

    const { rows: settingsRows } = await client.query<{ delete_enabled: boolean }>(
      `SELECT delete_enabled FROM arena.raw_retention_settings WHERE singleton`
    )
    const blockedBy: Array<'env' | 'db_switch'> = []
    if (env[RAW_RETENTION_DELETE_ENV] !== '1') blockedBy.push('env')
    if (settingsRows[0]?.delete_enabled !== true) blockedBy.push('db_switch')
    const mode: 'count' | 'delete' = blockedBy.length === 0 ? 'delete' : 'count'

    const census = await readCheapCensus(client, settingsRows[0]?.delete_enabled === true)

    const pointer: RawPointerScanTally = {
      pages: 0,
      rows: 0,
      expired_rows: 0,
      snapshot_pinned_rows: 0,
      trust_pinned_rows: 0,
      eligible_rows: 0,
      eligible_bytes: 0,
      pass_complete: false,
    }
    while (pointer.pages < maxScanPages && !pointer.pass_complete && !pastDeadline()) {
      const { rows } = await client.query<{ result: PointerPageResult }>(
        `SELECT arena.scan_raw_pointer_retention($1::integer, $2::integer) AS result`,
        [scanPageSize, retentionDays]
      )
      const page = rows[0]?.result ?? {}
      pointer.pages += 1
      pointer.rows += asNumber(page.page_rows)
      pointer.expired_rows += asNumber(page.page_expired_rows)
      pointer.snapshot_pinned_rows += asNumber(page.page_snapshot_pinned_rows)
      pointer.trust_pinned_rows += asNumber(page.page_trust_pinned_rows)
      pointer.eligible_rows += asNumber(page.page_eligible_rows)
      pointer.eligible_bytes += asNumber(page.page_eligible_bytes)
      pointer.pass_complete = page.pass_complete === true
    }

    const scan: RawOrphanScanTally = {
      pages: 0,
      objects: 0,
      bytes: 0,
      orphans: 0,
      orphan_bytes: 0,
      enqueued: 0,
      pass_complete: false,
      skipped: null,
    }
    while (scan.pages < maxScanPages && !scan.pass_complete && !pastDeadline()) {
      const { rows } = await client.query<{ result: ScanPageResult }>(
        `SELECT arena.scan_raw_storage_orphans($1::integer, $2::integer, $3::boolean) AS result`,
        [scanPageSize, retentionDays, mode === 'delete']
      )
      const page = rows[0]?.result ?? {}
      if (page.skipped) {
        scan.skipped = page.skipped
        break
      }
      scan.pages += 1
      scan.objects += asNumber(page.page_objects)
      scan.bytes += asNumber(page.page_bytes)
      scan.orphans += asNumber(page.page_orphans)
      scan.orphan_bytes += asNumber(page.page_orphan_bytes)
      scan.enqueued += asNumber(page.enqueued)
      scan.pass_complete = page.pass_complete === true
    }

    const orphanRemoved =
      mode === 'delete' ? await drainOrphanQueue(client, maxOrphanBatches, pastDeadline) : 0

    const { rows: passRows } = await client.query<{
      pointer_pass: Record<string, unknown> | null
      orphan_pass: Record<string, unknown> | null
      pointer_progress: Record<string, unknown> | null
      orphan_progress: Record<string, unknown> | null
    }>(RAW_PASS_PROGRESS_SQL)

    report = {
      contract: 'arena.raw-retention-run@1',
      mode,
      delete_blocked_by: blockedBy,
      census,
      pointer_scan: pointer,
      pointer_pass_progress: passRows[0]?.pointer_progress ?? null,
      last_completed_pointer_pass: passRows[0]?.pointer_pass ?? null,
      orphan_scan: scan,
      orphan_pass_progress: passRows[0]?.orphan_progress ?? null,
      last_completed_orphan_pass: passRows[0]?.orphan_pass ?? null,
      orphan_gc_removed: orphanRemoved,
      pointer_gc_removed: 0,
      stopped_by_deadline: false,
    }
  } catch (error) {
    destroyClient = true
    throw error
  } finally {
    if (!destroyClient) {
      try {
        await client.query('RESET statement_timeout')
      } catch {
        destroyClient = true
      }
    }
    client.release(destroyClient)
  }

  // Extra pointer GC batches beyond the routine single batch: delete mode only.
  if (report.mode === 'delete') {
    for (let batch = 0; batch < maxPointerBatches && !pastDeadline(); batch += 1) {
      const removed = await cleanupRawObjects(retentionDays)
      report.pointer_gc_removed += removed
      if (removed === 0) break
    }
  }
  report.stopped_by_deadline = pastDeadline()
  return report
}
