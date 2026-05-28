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
  queue = new Queue(QUEUE_NAME, { connection: getConnection() })
  return queue
}

// ── Job names ──

export const JOB = {
  // Stage 1: Fetch leaderboard data from exchanges
  FETCH_PLATFORM: 'fetch:platform',

  // Stage 2: Enrich with advanced metrics
  ENRICH_PLATFORM: 'enrich:platform',

  // Stage 3: Compute Arena Score + rankings
  COMPUTE_LEADERBOARD: 'score:compute',

  // Stage 4: Distribute (cache, search, revalidate)
  SYNC_REDIS: 'distribute:redis',
  SYNC_MEILISEARCH: 'distribute:meilisearch',
  REVALIDATE_PAGES: 'distribute:revalidate',

  // Scheduling
  SCHEDULE_FETCH_ALL: 'schedule:fetch-all',
  SCHEDULE_ENRICH_ALL: 'schedule:enrich-all',
  SCHEDULE_SCORE_ALL: 'schedule:score-all',
} as const

// ── Job data types ──

export interface FetchPlatformData {
  platform: string
  windows: string[]
}

export interface EnrichPlatformData {
  platform: string
  period: string
  limit: number
}

export interface ComputeLeaderboardData {
  season: '7D' | '30D' | '90D'
}
