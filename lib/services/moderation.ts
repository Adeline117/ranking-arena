/**
 * Moderation service — graduated sanctions system
 *
 * Strike escalation ladder:
 *   1st offense → warning
 *   2nd offense → warning
 *   3rd offense → 3-day mute
 *   4th offense → 7-day ban
 *   5th+ offense → permanent ban
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/utils/logger'

const logger = createLogger('moderation')

export type StrikeType = 'warning' | 'mute' | 'temp_ban' | 'perm_ban'

export interface Strike {
  id: string
  user_id: string
  issued_by: string
  reason: string
  strike_type: StrikeType
  expires_at: string | null
  created_at: string
}

/**
 * Issue a warning strike against a user
 */
export async function issueWarning(
  supabase: SupabaseClient,
  userId: string,
  reason: string,
  issuedBy: string
): Promise<Strike> {
  const { data, error } = await supabase
    .from('user_strikes')
    .insert({
      user_id: userId,
      issued_by: issuedBy,
      reason,
      strike_type: 'warning',
    })
    .select()
    .single()

  if (error) {
    logger.error('Failed to issue warning', { userId, error })
    throw new Error(`Failed to issue warning: ${error.message}`)
  }

  // Audit log
  await supabase.from('admin_logs').insert({
    admin_id: issuedBy,
    action: 'issue_warning',
    target_type: 'user',
    target_id: userId,
    details: { reason },
  })

  logger.info('Warning issued', { userId, issuedBy, reason })
  return data
}

/**
 * Issue a temporary ban with expiry
 */
export async function issueTempBan(
  supabase: SupabaseClient,
  userId: string,
  reason: string,
  durationDays: number,
  issuedBy: string
): Promise<Strike> {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + durationDays)

  const { data, error } = await supabase
    .from('user_strikes')
    .insert({
      user_id: userId,
      issued_by: issuedBy,
      reason,
      strike_type: 'temp_ban',
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single()

  if (error) {
    logger.error('Failed to issue temp ban', { userId, error })
    throw new Error(`Failed to issue temp ban: ${error.message}`)
  }

  // Also ban user in user_profiles
  await supabase
    .from('user_profiles')
    .update({
      banned_at: new Date().toISOString(),
      banned_reason: reason,
      banned_by: issuedBy,
      ban_expires_at: expiresAt.toISOString(),
    })
    .eq('id', userId)

  // Audit log
  await supabase.from('admin_logs').insert({
    admin_id: issuedBy,
    action: 'issue_temp_ban',
    target_type: 'user',
    target_id: userId,
    details: { reason, durationDays, expiresAt: expiresAt.toISOString() },
  })

  logger.info('Temp ban issued', { userId, issuedBy, durationDays, reason })
  return data
}

/**
 * Get all strikes for a user (history)
 */
export async function getStrikeHistory(
  supabase: SupabaseClient,
  userId: string
): Promise<Strike[]> {
  const { data, error } = await supabase
    .from('user_strikes')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('Failed to fetch strike history', { userId, error })
    throw new Error(`Failed to fetch strike history: ${error.message}`)
  }

  return data || []
}

/**
 * Get active (unexpired) strikes for a user
 */
export async function getActiveStrikes(
  supabase: SupabaseClient,
  userId: string
): Promise<Strike[]> {
  const now = new Date().toISOString()

  const { data, error } = await supabase
    .from('user_strikes')
    .select('*')
    .eq('user_id', userId)
    .or(`expires_at.is.null,expires_at.gt.${now}`)
    .order('created_at', { ascending: false })

  if (error) {
    logger.error('Failed to fetch active strikes', { userId, error })
    throw new Error(`Failed to fetch active strikes: ${error.message}`)
  }

  return data || []
}

/**
 * Auto-escalate based on total strike count:
 *   1st → warning
 *   2nd → warning
 *   3rd → 3-day mute (temp_ban)
 *   4th → 7-day ban (temp_ban)
 *   5th+ → permanent ban
 */
export async function autoEscalate(
  supabase: SupabaseClient,
  userId: string,
  reason: string,
  issuedBy: string
): Promise<Strike> {
  // Count ALL historical strikes (not just active)
  const history = await getStrikeHistory(supabase, userId)
  const totalStrikes = history.length

  if (totalStrikes >= 4) {
    // 5th+ → permanent ban
    return issuePermanentBan(supabase, userId, `Auto-escalation (strike #${totalStrikes + 1}): ${reason}`, issuedBy)
  } else if (totalStrikes === 3) {
    // 4th → 7-day ban
    return issueTempBan(supabase, userId, `Auto-escalation (strike #4): ${reason}`, 7, issuedBy)
  } else if (totalStrikes === 2) {
    // 3rd → 3-day mute
    return issueMute(supabase, userId, `Auto-escalation (strike #3): ${reason}`, 3, issuedBy)
  } else {
    // 1st or 2nd → warning
    return issueWarning(supabase, userId, `Auto-escalation (strike #${totalStrikes + 1}): ${reason}`, issuedBy)
  }
}

/**
 * Issue a mute (stored as strike_type='mute' with expiry)
 */
async function issueMute(
  supabase: SupabaseClient,
  userId: string,
  reason: string,
  durationDays: number,
  issuedBy: string
): Promise<Strike> {
  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + durationDays)

  const { data, error } = await supabase
    .from('user_strikes')
    .insert({
      user_id: userId,
      issued_by: issuedBy,
      reason,
      strike_type: 'mute',
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single()

  if (error) {
    logger.error('Failed to issue mute', { userId, error })
    throw new Error(`Failed to issue mute: ${error.message}`)
  }

  // Audit log
  await supabase.from('admin_logs').insert({
    admin_id: issuedBy,
    action: 'issue_mute',
    target_type: 'user',
    target_id: userId,
    details: { reason, durationDays, expiresAt: expiresAt.toISOString() },
  })

  logger.info('Mute issued', { userId, issuedBy, durationDays, reason })
  return data
}

/**
 * Issue a permanent ban
 */
async function issuePermanentBan(
  supabase: SupabaseClient,
  userId: string,
  reason: string,
  issuedBy: string
): Promise<Strike> {
  const { data, error } = await supabase
    .from('user_strikes')
    .insert({
      user_id: userId,
      issued_by: issuedBy,
      reason,
      strike_type: 'perm_ban',
    })
    .select()
    .single()

  if (error) {
    logger.error('Failed to issue permanent ban', { userId, error })
    throw new Error(`Failed to issue permanent ban: ${error.message}`)
  }

  // Ban user in user_profiles (no expiry)
  await supabase
    .from('user_profiles')
    .update({
      banned_at: new Date().toISOString(),
      banned_reason: reason,
      banned_by: issuedBy,
    })
    .eq('id', userId)

  // Audit log
  await supabase.from('admin_logs').insert({
    admin_id: issuedBy,
    action: 'issue_perm_ban',
    target_type: 'user',
    target_id: userId,
    details: { reason },
  })

  logger.info('Permanent ban issued', { userId, issuedBy, reason })
  return data
}
