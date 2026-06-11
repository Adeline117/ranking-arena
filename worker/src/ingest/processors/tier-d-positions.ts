/**
 * Tier D open-positions snapshot (top-100) — ARENA_DATA_SPEC v1.2.
 * Stub: implemented in its dedicated Phase-0 commit; the router already
 * dispatches here so wiring lands once.
 */

import type { Job } from 'bullmq'

export async function processTierD(job: Job): Promise<unknown> {
  throw new Error(`[ingest] ${job.name} not implemented yet (stub)`)
}
