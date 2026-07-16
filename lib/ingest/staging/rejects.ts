/**
 * Durable staging-reject audit writer.
 *
 * Profile quality gates run after the immutable RAW pointer exists but before
 * any serving publication. Keeping this writer outside `publishProfile`
 * lets a rejected surface record its reason without opening (or partially
 * executing) a serving transaction.
 */

import { getIngestPool } from '../db'
import type { RejectedRow } from './validate'

export async function recordStagingRejects(
  sourceId: number,
  rawObjectId: number,
  rejects: readonly RejectedRow[]
): Promise<void> {
  if (rejects.length === 0) return
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error(`invalid staging reject source id: ${sourceId}`)
  }
  if (!Number.isSafeInteger(rawObjectId) || rawObjectId <= 0) {
    throw new Error(`invalid staging reject raw object id: ${rawObjectId}`)
  }

  await getIngestPool().query(
    `INSERT INTO arena.staging_rejects (source_id, raw_object_id, reason, row_payload)
     SELECT $1, $2, r.reason, r.payload
       FROM jsonb_to_recordset($3::jsonb) AS r(reason text, payload jsonb)`,
    [
      sourceId,
      rawObjectId,
      JSON.stringify(
        rejects.map((reject) => ({ reason: reject.reason, payload: reject.payload ?? {} }))
      ),
    ]
  )
}
