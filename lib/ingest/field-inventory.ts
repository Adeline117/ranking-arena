/**
 * Upstream field inventory (P1 of the data-completeness system, 2026-07-04).
 *
 * Exchanges add fields silently (e.g. a source starts returning sortino) and
 * nothing in the pipeline would ever notice — RAW payloads live as external
 * gzipped blobs (30-day retention, not SQL-queryable), so the ONLY place to
 * observe upstream shape is the ingest hot path while the payload is still in
 * memory. Tier-A/B processors call recordFieldInventory (sampled,
 * fire-and-forget); the daily sentinel reports field paths first seen in the
 * last 24h as "上游新字段" Telegram digests.
 */

import { getIngestPool } from './db'

/** Path count cap per payload — malformed/huge payloads can't flood the table. */
const MAX_PATHS = 300
/** Recursion depth over OBJECT levels (arrays are descended for free via []). */
const MAX_DEPTH = 3

/**
 * Collect field paths like `data.list[].roi` from a RAW payload.
 * Arrays sample their FIRST element only (shape, not content).
 */
export function collectFieldPaths(payload: unknown, depth = MAX_DEPTH): string[] {
  const out = new Set<string>()
  const walk = (node: unknown, prefix: string, budget: number): void => {
    if (out.size >= MAX_PATHS || budget < 0) return
    if (Array.isArray(node)) {
      if (node.length > 0) walk(node[0], `${prefix}[]`, budget)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (out.size >= MAX_PATHS) return
      const path = prefix ? `${prefix}.${key}` : key
      out.add(path)
      walk((node as Record<string, unknown>)[key], path, budget - 1)
    }
  }
  walk(payload, '', depth)
  return [...out]
}

/**
 * Upsert the payload's field paths for (source, jobType). Fire-and-forget by
 * design: callers must NOT await-and-fail a crawl on inventory errors —
 * observation must never break ingestion.
 */
export async function recordFieldInventory(
  sourceId: number,
  jobType: string,
  payload: unknown
): Promise<void> {
  const paths = collectFieldPaths(payload)
  if (paths.length === 0) return
  const values: string[] = []
  const params: unknown[] = []
  let i = 1
  for (const p of paths) {
    values.push(`($${i++}, $${i++}, $${i++})`)
    params.push(sourceId, jobType, p)
  }
  await getIngestPool().query(
    `INSERT INTO arena.upstream_field_inventory (source_id, job_type, field_path)
     VALUES ${values.join(',')}
     ON CONFLICT (source_id, job_type, field_path)
     DO UPDATE SET last_seen = now()`,
    params
  )
}
