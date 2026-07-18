/**
 * Recount Follow Counts Cron
 * GET /api/cron/recount-follow-counts
 *
 * Runs every 6 hours. Recounts follower_count/following_count on user_profiles
 * from user_follows source of truth to fix any drift from fire-and-forget updates.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import logger from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'

export const runtime = 'nodejs'
export const preferredRegion = 'sfo1'
export const dynamic = 'force-dynamic'
export const maxDuration = 60

export const GET = withCron('recount-follow-counts', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin()

  const { data, error } = await supabase.rpc('recount_all_follow_counts')

  if (error) {
    logger.error('[recount-follow-counts] RPC error:', error)
    throw error
  }

  const updatedCount = data?.[0]?.updated_count ?? 0
  logger.info(`[recount-follow-counts] Fixed ${updatedCount} user profiles`)

  return { count: Number(updatedCount) }
})
