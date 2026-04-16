/**
 * Cron: Ensure future partitions for trader_snapshots_v2
 * Schedule: Weekly (Sundays at 03:00 UTC)
 *
 * Calls the ensure_future_partitions(4) DB function to pre-create monthly
 * partitions for the next 4 months. Prevents INSERT failures when reaching
 * the end of pre-created partitions.
 *
 * Root cause fix: partitions were manually created up to 2026-08, but no
 * automated mechanism to create more as data grows.
 */

import { withCron } from '@/lib/api/with-cron'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron('ensure-partitions', async (_request, { supabase }) => {
  const { data, error } = await supabase.rpc('ensure_future_partitions', { months_ahead: 4 })

  if (error) {
    throw new Error(`ensure_future_partitions failed: ${error.message}`)
  }

  return {
    count: 1,
    partitions_created: data,
  }
})
