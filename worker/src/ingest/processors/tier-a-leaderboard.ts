/**
 * Tier A leaderboard crawl — ARENA_DATA_SPEC v1.2 §2.3.
 * Stub: implemented in the RAW→STAGING→SERVING milestone commit.
 */

import type { Job } from 'bullmq'

export async function processTierA(job: Job): Promise<unknown> {
  throw new Error(`[ingest] ${job.name} not implemented yet (stub)`)
}
