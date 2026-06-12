/**
 * Queue definitions for the Arena data pipeline.
 *
 * Single queue with job-name-based routing (simpler than multiple queues,
 * fewer Redis connections). BullMQ opens 2 connections per queue for
 * blocking commands — keeping it to 1 queue = 2 connections total.
 */

import { Queue } from 'bullmq'
import { getConnection } from './connection'

export const QUEUE_NAME = 'arena-pipeline'

let queue: Queue | null = null

export function getQueue(): Queue {
  if (queue) return queue
  queue = new Queue(QUEUE_NAME, {
    connection: getConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600, count: 5000 },
    },
  })
  return queue
}

// ── Job names ──

// ENDGAME (ARENA_DATA_SPEC v1.2): legacy fetch:platform / enrich:platform jobs
// removed — leaderboard data is produced by the arena-ingest queue. This queue
// only carries the downstream chain (Arena Score + Meilisearch sync).
export const JOB = {
  // Compute Arena Score + rankings
  COMPUTE_LEADERBOARD: 'score:compute',

  // Distribute (search)
  SYNC_MEILISEARCH: 'distribute:meilisearch',
} as const

// ── Job data types ──

export interface ComputeLeaderboardData {
  season: '7D' | '30D' | '90D'
}
