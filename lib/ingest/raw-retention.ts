/**
 * RAW retention backlog (20261118134316). Runs from the worker maintenance
 * job right after the routine single-batch cleanupRawObjects(30).
 *
 * Count-only by default. Every run reports the pointer-side census and walks
 * a bounded slice of the raw-snapshots bucket looking for objects that have no
 * arena.raw_objects pointer (they can never enter arena.raw_object_gc_queue).
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

export interface RawRetentionReport {
  contract: 'arena.raw-retention-run@1'
  mode: 'count' | 'delete'
  delete_blocked_by: Array<'env' | 'db_switch'>
  census: Record<string, unknown>
  orphan_scan: RawOrphanScanTally
  last_completed_orphan_pass: Record<string, unknown> | null
  orphan_gc_removed: number
  pointer_gc_removed: number
  stopped_by_deadline: boolean
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

const asNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
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
): Promise<RawRetentionReport | 'not_installed'> {
  const retentionDays = options.retentionDays ?? 30
  const scanPageSize = options.scanPageSize ?? 50_000
  const maxScanPages = options.maxScanPages ?? 20
  const maxPointerBatches = options.maxPointerBatches ?? 40
  const maxOrphanBatches = options.maxOrphanBatches ?? 40
  const now = options.now ?? Date.now
  const deadline = now() + (options.deadlineMs ?? 20 * 60_000)
  const pastDeadline = () => now() >= deadline
  const env = options.env ?? process.env

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

    await client.query(`SET statement_timeout = '120s'`)

    const { rows: settingsRows } = await client.query<{ delete_enabled: boolean }>(
      `SELECT delete_enabled FROM arena.raw_retention_settings WHERE singleton`
    )
    const blockedBy: Array<'env' | 'db_switch'> = []
    if (env[RAW_RETENTION_DELETE_ENV] !== '1') blockedBy.push('env')
    if (settingsRows[0]?.delete_enabled !== true) blockedBy.push('db_switch')
    const mode: 'count' | 'delete' = blockedBy.length === 0 ? 'delete' : 'count'

    const { rows: censusRows } = await client.query<{ census: Record<string, unknown> }>(
      `SELECT arena.raw_retention_census($1::integer) AS census`,
      [retentionDays]
    )

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
      pass: Record<string, unknown> | null
    }>(
      `SELECT last_completed_orphan_pass AS pass FROM arena.raw_retention_settings WHERE singleton`
    )

    report = {
      contract: 'arena.raw-retention-run@1',
      mode,
      delete_blocked_by: blockedBy,
      census: censusRows[0]?.census ?? {},
      orphan_scan: scan,
      last_completed_orphan_pass: passRows[0]?.pass ?? null,
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
