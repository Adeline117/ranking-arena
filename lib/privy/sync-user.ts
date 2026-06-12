/**
 * Privy → Supabase User Sync
 *
 * After Privy login, attempts to create a user_profile; an existing profile
 * is detected via the insert's unique violation (23505) instead of an
 * email lookup (client-side email reads are forbidden — PII).
 * Does NOT create a Supabase Auth session.
 */

import { supabase as _supabase } from '@/lib/supabase/client'
import type { SupabaseClient } from '@supabase/supabase-js'
const supabase = _supabase as SupabaseClient
import { logger } from '@/lib/logger'

interface PrivyUserInfo {
  privyId: string
  email?: string | null
  walletAddress?: string | null
}

/**
 * Ensure a user_profile exists for this Privy user.
 * Returns handle for redirect (null for returning users — caller only uses isNew).
 */
export async function syncPrivyUserToSupabase(
  info: PrivyUserInfo
): Promise<{ handle: string | null; isNew: boolean }> {
  try {
    // SECURITY: do NOT look up profiles by email from the browser.
    // The previous `.select('id, handle').eq('email', ...)` probe was a
    // cross-user email read (email-enumeration: any visitor could learn
    // whether an email has an account, and its handle). It also breaks under
    // the user_profiles column-level SELECT REVOKE — filtering on `email`
    // requires SELECT privilege on that column (42501).
    // Existing-profile detection now relies on the insert's unique violation.

    const handle = info.email
      ? info.email.split('@')[0]
      : info.walletAddress
        ? `user_${info.walletAddress.slice(2, 10).toLowerCase()}`
        : `user_${info.privyId.slice(-8)}`

    // Try to insert — may fail due to RLS if no auth session
    const { data: newProfile, error: insertError } = await supabase
      .from('user_profiles')
      .insert({
        email: info.email || null,
        handle,
      })
      .select('handle')
      .single()

    if (insertError) {
      // 23505 unique violation — a profile already exists for this email/handle.
      // Returning user: don't expose the existing profile's data (the caller
      // only branches on isNew for the redirect; handle is unused).
      if (insertError.code === '23505') {
        return { handle: null, isNew: false }
      }
      // RLS may block unauthenticated inserts — that's expected
      // User will need to complete onboarding after Supabase auth link
      logger.warn('Could not auto-create profile (RLS):', insertError.message)
      return { handle, isNew: true }
    }

    return { handle: newProfile?.handle || handle, isNew: true }
  } catch (err) {
    logger.error('syncPrivyUserToSupabase error:', err)
    return { handle: null, isNew: false }
  }
}
