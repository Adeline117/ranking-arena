/**
 * Primary/standby placement for framework maintenance jobs.
 *
 * WHY (2026-11 audit P1-4 / P2-3): housekeeping (incl. partition pre-creation),
 * the freshness sentinel and the daily digest were registered ONLY on the
 * `local` (Mac) queue, and cross-region failover is disabled. When the Mac
 * node dies the SG node keeps crawling with no freshness sentinel, no digest
 * and no partition pre-creation — nothing reports that the node is gone.
 *
 * Minimal safe fix: the `local` queue keeps the PRIMARY scheduler (unchanged
 * id). Each standby region (SG) gets a STANDBY copy (`<id>:<region>`, job data
 * `{ standby: true }`) on its own queue. A standby run executes only when the
 * primary has not completed that job within STANDBY_GRACE × cadence, so while
 * the Mac is healthy nothing runs twice; when it is down SG takes over at the
 * same cadence. The primary marker is written only by primary runs, so SG's
 * own runs never mask a dead primary.
 *
 * On-chain enrich stays local-only (provider keys + a global lease already
 * guard it; doubling it would only add cost).
 */

import type IORedis from 'ioredis'
import { INGEST_JOB } from './job-names'

export const MAINTENANCE_STANDBY_REGIONS = ['vps_sg'] as const

/** Cadence of every framework job; the scheduler registers from this table. */
export const MAINTENANCE_SCHEDULES = [
  { id: 'maint:housekeeping', name: INGEST_JOB.MAINTENANCE, everyMs: 6 * 3600_000, standby: true },
  { id: 'maint:freshness', name: INGEST_JOB.FRESHNESS, everyMs: 30 * 60_000, standby: true },
  {
    id: 'maint:daily-digest',
    name: INGEST_JOB.DAILY_DIGEST,
    everyMs: 24 * 3600_000,
    standby: true,
  },
  // Top-N web3 wallets recomputed on-chain (durable; replaces WAF-blocked
  // profile detail). 12h cadence — bounded by ONCHAIN_ENRICH_TOPN + retry.
  {
    id: 'maint:onchain-enrich',
    name: INGEST_JOB.ONCHAIN_ENRICH,
    everyMs: 12 * 3600_000,
    standby: false,
  },
] as const

/** A standby run takes over once the primary is this many cadences late. */
export const STANDBY_GRACE = 1.5

const lastRunKey = (jobName: string, role: 'primary' | 'standby') =>
  `arena:ingest:maint-last:${jobName}:${role}`

export function isStandbyJob(data: unknown): boolean {
  return (
    data !== null && typeof data === 'object' && (data as Record<string, unknown>).standby === true
  )
}

function cadenceOf(jobName: string): number | null {
  return MAINTENANCE_SCHEDULES.find((s) => s.name === jobName)?.everyMs ?? null
}

/**
 * Run `fn` under the primary/standby contract. Primary runs always execute
 * and refresh the primary marker on success. Standby runs execute only when
 * the primary marker is missing or older than STANDBY_GRACE × cadence.
 * A Redis read failure on the standby side fails OPEN (runs): the jobs are
 * idempotent, and a blind standby must not silence the sentinel.
 */
export async function runMaintenanceWithStandby<T>(
  redis: Pick<IORedis, 'get' | 'set'>,
  jobName: string,
  data: unknown,
  fn: () => Promise<T>,
  now: () => number = Date.now
): Promise<T | { skipped: 'primary-healthy'; primaryLastRunAt: string }> {
  const standby = isStandbyJob(data)
  if (standby) {
    const everyMs = cadenceOf(jobName)
    try {
      const raw = await redis.get(lastRunKey(jobName, 'primary'))
      const last = raw ? Number(raw) : NaN
      if (everyMs && Number.isFinite(last) && now() - last < STANDBY_GRACE * everyMs) {
        return { skipped: 'primary-healthy', primaryLastRunAt: new Date(last).toISOString() }
      }
    } catch (err) {
      console.error(
        `[maint-standby] ${jobName}: primary marker unreadable, standby runs:`,
        err instanceof Error ? err.message : err
      )
    }
    console.warn(`[maint-standby] ${jobName}: primary overdue — standby node is running it`)
  }

  const result = await fn()
  try {
    await redis.set(lastRunKey(jobName, standby ? 'standby' : 'primary'), String(now()))
  } catch (err) {
    console.error(
      `[maint-standby] ${jobName}: could not record last run:`,
      err instanceof Error ? err.message : err
    )
  }
  return result
}
