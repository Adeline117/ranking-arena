/**
 * Worker heartbeat (de-single-point, P0 detection half).
 *
 * The ingest workers run off-Vercel (Mac Mini for the `local` region, SG VPS
 * for `vps_sg`). If the Mac Mini dies, ~83% of sources stop crawling — but
 * data-freshness alarms can't catch it quickly: Tier-A cadence is 5-6h, so a
 * healthy source is already 0-6h stale and "dead" is indistinguishable from
 * "normal cadence" until >12h pass. The OpenClaw 30-min monitor runs ON the
 * Mac, so it dies with it (circular).
 *
 * Fix: each worker writes a liveness timestamp every 60s into a hash on the
 * SHARED cloud Redis (Upstash — survives the node dying). A Vercel cron
 * (independent of every worker node) reads the hash and pages within ~15min
 * when a node's heartbeat goes stale. Detection is decoupled from crawl
 * cadence entirely.
 */

import type IORedis from 'ioredis'
import { hostname } from 'node:os'

export const WORKER_ROSTER_KEY = 'arena:worker:roster'
const BEAT_INTERVAL_MS = 60_000

/** Stable per-machine id; override with WORKER_NODE_ID when running multiple
 *  workers on one host or to give nodes friendly names. */
export function workerNodeId(): string {
  return process.env.WORKER_NODE_ID || hostname()
}

interface HeartbeatPayload {
  ts: number
  regions: string[]
  pid: number
  node: string
}

/**
 * Start emitting heartbeats. Writes once immediately, then every 60s. Returns
 * the timer so the caller can clearInterval on shutdown. Failures are logged,
 * never thrown — a heartbeat hiccup must not crash the worker.
 */
export function startHeartbeat(redis: IORedis, regions: string[]): NodeJS.Timeout {
  const node = workerNodeId()
  const beat = async (): Promise<void> => {
    const payload: HeartbeatPayload = { ts: Date.now(), regions, pid: process.pid, node }
    try {
      await redis.hset(WORKER_ROSTER_KEY, node, JSON.stringify(payload))
    } catch (err) {
      console.error('[heartbeat] write failed:', err instanceof Error ? err.message : err)
    }
  }
  void beat()
  const timer = setInterval(() => void beat(), BEAT_INTERVAL_MS)
  // Don't let the heartbeat timer keep the event loop alive on shutdown.
  if (typeof timer.unref === 'function') timer.unref()
  console.log(
    `[heartbeat] node=${node} regions=${regions.join(',')} every ${BEAT_INTERVAL_MS / 1000}s`
  )
  return timer
}
