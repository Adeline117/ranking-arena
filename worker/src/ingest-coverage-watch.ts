/**
 * The scoring process watches the ingest heartbeat (incident 2026-11-21).
 *
 * Every ingest stall check (stale boards, deep-crawl silence, region
 * coverage) runs inside the ingest worker's own sentinel job. When that
 * worker lost its authority and lingered with every consumer stopped, the
 * sentinel stopped with it and nothing noticed for about seven hours: the
 * monitor and the monitored were one process. The single local node has no
 * peer either (the SG standby is not running).
 *
 * The scoring worker is a separate process on the same Redis. It now reads
 * the shared heartbeat roster on a timer and pages a region no fresh ingest
 * worker consumes, through the same alert and cooldown key as the ingest
 * sentinel (so the two never double-page). A heartbeat is stale after
 * WORKER_HEARTBEAT_STALE_MS (5 minutes); with a 5-minute check the page goes
 * out within about ten minutes of the last heartbeat.
 */

import type IORedis from 'ioredis'
import { alertUncoveredRegions } from './ingest/region-coverage'

export const INGEST_COVERAGE_WATCH_INTERVAL_MS = 5 * 60_000

export function startIngestCoverageWatch(
  redis: IORedis,
  options: {
    intervalMs?: number
    check?: (redis: IORedis) => Promise<unknown>
    log?: (message: string, error: unknown) => void
  } = {}
): NodeJS.Timeout {
  const check = options.check ?? ((connection: IORedis) => alertUncoveredRegions(connection))
  const log = options.log ?? ((message, error) => console.error(message, error))
  const run = () => {
    // A failed read or an undelivered page is logged and retried on the next
    // tick; it must never take the scoring worker down.
    void check(redis).catch((error: unknown) =>
      log('[worker] ingest coverage watch failed:', error instanceof Error ? error.message : error)
    )
  }
  const timer = setInterval(run, options.intervalMs ?? INGEST_COVERAGE_WATCH_INTERVAL_MS)
  timer.unref()
  return timer
}
