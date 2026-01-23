/**
 * Worker Entry Point
 *
 * Standalone worker process that continuously processes jobs.
 * Can be run as:
 *   - Node process: npx tsx lib/jobs/worker.ts
 *   - Docker container
 *   - Vercel cron (via API route trigger)
 *
 * Environment variables:
 *   NEXT_PUBLIC_SUPABASE_URL - Supabase project URL
 *   SUPABASE_SERVICE_ROLE_KEY - Service role key for DB access
 *   WORKER_BATCH_SIZE - Jobs per batch (default: 5)
 *   WORKER_POLL_INTERVAL - Poll interval in ms (default: 5000)
 *   WORKER_PLATFORMS - Comma-separated platforms (default: all)
 */

import { JobProcessor } from './processor'
import type { LeaderboardPlatform } from '../types/leaderboard'

// Parse configuration from environment
const batchSize = parseInt(process.env.WORKER_BATCH_SIZE || '5', 10)
const pollInterval = parseInt(process.env.WORKER_POLL_INTERVAL || '5000', 10)
const platforms = process.env.WORKER_PLATFORMS
  ? process.env.WORKER_PLATFORMS.split(',').map(p => p.trim()) as LeaderboardPlatform[]
  : null

const processor = new JobProcessor({
  batchSize,
  pollInterval,
  platforms,
})

// Graceful shutdown
let shutdownRequested = false

function handleShutdown(signal: string): void {
  if (shutdownRequested) {
    console.log('[Worker] Force exit')
    process.exit(1)
  }
  shutdownRequested = true
  console.log(`[Worker] Received ${signal}, shutting down gracefully...`)
  processor.stop()
  // Give 10s for in-flight jobs to complete
  setTimeout(() => process.exit(0), 10000)
}

process.on('SIGTERM', () => handleShutdown('SIGTERM'))
process.on('SIGINT', () => handleShutdown('SIGINT'))

// Start processing
console.log('[Worker] Starting job processor...')
console.log(`[Worker] Config: batch=${batchSize}, poll=${pollInterval}ms, platforms=${platforms || 'all'}`)

processor.start().catch(error => {
  console.error('[Worker] Fatal error:', error)
  process.exit(1)
})
