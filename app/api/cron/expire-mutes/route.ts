/**
 * Expire Mutes & Temp Bans Cron
 * GET /api/cron/expire-mutes
 *
 * Runs hourly. Clears expired group mutes and expired temp bans from user_strikes.
 */

import { NextRequest } from 'next/server'
import { getSupabaseAdmin } from '@/lib/supabase/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import logger from '@/lib/logger'
import { withCron } from '@/lib/api/with-cron'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 30

export const GET = withCron('expire-mutes', async (_request: NextRequest) => {
  const supabase = getSupabaseAdmin() as SupabaseClient
  const now = new Date().toISOString()
  let mutesCleared = 0
  let bansCleared = 0

  // 1. Clear expired group mutes
  const { data: expiredMutes, error: muteQueryError } = await supabase
    .from('group_members')
    .select('id, group_id, user_id')
    .not('muted_until', 'is', null)
    .lt('muted_until', now)

  if (muteQueryError) {
    logger.error('[expire-mutes] Error querying expired mutes:', muteQueryError)
  } else if (expiredMutes && expiredMutes.length > 0) {
    const ids = expiredMutes.map((m) => m.id)

    const { error: muteUpdateError } = await supabase
      .from('group_members')
      .update({
        muted_until: null,
        mute_reason: null,
        muted_by: null,
      })
      .in('id', ids)

    if (muteUpdateError) {
      logger.error('[expire-mutes] Error clearing mutes:', muteUpdateError)
    } else {
      mutesCleared = ids.length
      logger.info(`[expire-mutes] Cleared ${mutesCleared} expired group mutes`)
    }
  }

  // 2. Clear expired temp bans from user_strikes + unban from user_profiles
  const { data: expiredBans, error: banQueryError } = await supabase
    .from('user_strikes')
    .select('id, user_id')
    .in('strike_type', ['temp_ban', 'mute'])
    .not('expires_at', 'is', null)
    .lt('expires_at', now)

  if (banQueryError) {
    logger.error('[expire-mutes] Error querying expired bans:', banQueryError)
  } else if (expiredBans && expiredBans.length > 0) {
    bansCleared = expiredBans.length

    // Get unique user IDs with expired temp_bans to unban them
    const userIdsToUnban = [
      ...new Set(expiredBans.map((b) => b.user_id)),
    ]

    // For each user, check if they have any OTHER active bans before unbanning
    for (const userId of userIdsToUnban) {
      const { data: activeStrikes } = await supabase
        .from('user_strikes')
        .select('id, strike_type, expires_at')
        .eq('user_id', userId)
        .in('strike_type', ['temp_ban', 'perm_ban'])
        .or(`expires_at.is.null,expires_at.gt.${now}`)

      const hasActiveBan = activeStrikes && activeStrikes.some(
        (s) => s.strike_type === 'perm_ban' || (s.expires_at && s.expires_at > now)
      )

      if (!hasActiveBan) {
        // No other active bans — unban the user
        await supabase
          .from('user_profiles')
          .update({
            banned_at: null,
            banned_reason: null,
            banned_by: null,
            ban_expires_at: null,
          })
          .eq('id', userId)

        logger.info(`[expire-mutes] Unbanned user ${userId} (temp ban expired)`)
      }
    }
  }

  const totalProcessed = mutesCleared + bansCleared
  return { count: totalProcessed, mutesCleared, bansCleared }
})
