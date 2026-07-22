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
import { execFileSync, execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export const WORKER_ROSTER_KEY = 'arena:worker:roster'
const BEAT_INTERVAL_MS = 60_000

/** Stable per-machine id; override with WORKER_NODE_ID when running multiple
 *  workers on one host or to give nodes friendly names. */
export function workerNodeId(): string {
  return process.env.WORKER_NODE_ID || hostname()
}

/**
 * The commit this node is running, so the drift sentinel can alarm when two nodes
 * diverge (root cause of the SG node silently running 18-day-old code). Resolution
 * order: DEPLOYED_SHA file (written by worker/deploy-ingest-sg.sh on the rsync'd SG
 * node, which has no .git) → git rev-parse (the Mac Mini git checkout) → env →
 * 'unknown'. Computed once at startup. Never throws.
 */
export function resolveDeployedSha(): string {
  try {
    return readFileSync(resolve(process.cwd(), 'DEPLOYED_SHA'), 'utf8').trim()
  } catch {
    /* not a deployed node */
  }
  try {
    return execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    /* not a git checkout */
  }
  return process.env.DEPLOYED_SHA || 'unknown'
}

interface HeartbeatPayload {
  ts: number
  regions: string[]
  pid: number
  node: string
  sha: string
  /** Runtime cutover flag, reported explicitly so release gating cannot infer
   *  v3 attempt-bound capture from the code SHA alone. */
  attempt_bound_capture: boolean
  /** Used % for the filesystem containing the worker checkout, so the Vercel
   *  heartbeat-check cron can page before a node fills up and crashloops.
   *  Optional — older workers omit it; the cron treats absent as unknown. */
  disk?: number
}

type DiskUsageReader = (target: string) => string

function readDiskUsage(target: string): string {
  return execFileSync('df', ['-P', target], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
  })
}

/** Parse the Capacity column from POSIX `df -P` output. */
export function parseDiskUsedPct(output: string): number | undefined {
  const last = output.trim().split('\n').pop() || ''
  const match = last.match(/(?:^|\s)(\d{1,3})%(?:\s|$)/)
  if (!match) return undefined

  const used = Number(match[1])
  return Number.isInteger(used) && used >= 0 && used <= 100 ? used : undefined
}

/**
 * Used % for the filesystem containing the worker checkout. `process.cwd()`
 * resolves to the writable Data volume on macOS and `/` on the SG Linux host.
 * Never throws; returns undefined on any failure.
 */
export function diskUsedPct(
  target = process.cwd(),
  readUsage: DiskUsageReader = readDiskUsage
): number | undefined {
  try {
    return parseDiskUsedPct(readUsage(target))
  } catch {
    return undefined
  }
}

/**
 * Start emitting heartbeats. Writes once immediately, then every 60s. Returns
 * the timer so the caller can clearInterval on shutdown. Failures are logged,
 * never thrown — a heartbeat hiccup must not crash the worker.
 */
export function startHeartbeat(redis: IORedis, regions: string[]): NodeJS.Timeout {
  const node = workerNodeId()
  const sha = resolveDeployedSha()
  const beat = async (): Promise<void> => {
    const payload: HeartbeatPayload = {
      ts: Date.now(),
      regions,
      pid: process.pid,
      node,
      sha,
      attempt_bound_capture: process.env.INGEST_ATTEMPT_BOUND_CAPTURE_ENABLED === 'true',
      disk: diskUsedPct(),
    }
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
    `[heartbeat] node=${node} regions=${regions.join(',')} sha=${sha.slice(0, 9)} every ${BEAT_INTERVAL_MS / 1000}s`
  )
  return timer
}
