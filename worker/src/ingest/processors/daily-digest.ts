/**
 * Daily digest (spec §15 alerting discipline): everything that didn't page
 * — long-tail breakage, Tier-B/C issues, count drifts, maintenance errors —
 * flushed once a day in a single Telegram summary.
 */

import type { Job } from 'bullmq'
import { getConnection } from '../../connection'
import { flushDigest } from '@/lib/ingest/alerting'

export async function processDailyDigest(_job: Job): Promise<{ flushed: number }> {
  const flushed = await flushDigest(getConnection())
  console.log(`[daily-digest] flushed ${flushed} events`)
  return { flushed }
}
