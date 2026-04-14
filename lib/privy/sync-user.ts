/**
 * Privy → Supabase User Sync
 * 
 * After Privy login, checks if a user_profile exists (by email).
 * If not, creates one. Does NOT create a Supabase Auth session.
 */

import { supabase as _supabase } from '@/lib/supabase/client';
import type { SupabaseClient } from '@supabase/supabase-js';
const supabase = _supabase as SupabaseClient;
import { logger } from '@/lib/logger';

interface PrivyUserInfo {
  privyId: string;
  email?: string | null;
  walletAddress?: string | null;
}

/**
 * Ensure a user_profile exists for this Privy user.
 * Matches by email if available. Returns handle for redirect.
 */
export async function syncPrivyUserToSupabase(info: PrivyUserInfo): Promise<{ handle: string | null; isNew: boolean }> {
  try {
    // If user has email, check if a profile exists with that email
    if (info.email) {
      const { data: emailProfile } = await supabase
        .from('user_profiles')
        .select('id, handle')
        .eq('email', info.email)
        .maybeSingle();

      if (emailProfile) {
        return { handle: emailProfile.handle, isNew: false };
      }
    }

    // No existing profile — create one via edge function or direct insert
    const handle = info.email
      ? info.email.split('@')[0]
      : info.walletAddress
        ? `user_${info.walletAddress.slice(2, 10).toLowerCase()}`
        : `user_${info.privyId.slice(-8)}`;

    // Try to insert — may fail due to RLS if no auth session
    const { data: newProfile, error: insertError } = await supabase
      .from('user_profiles')
      .insert({
        email: info.email || null,
        handle,
      })
      .select('handle')
      .single();

    if (insertError) {
      // RLS may block unauthenticated inserts — that's expected
      // User will need to complete onboarding after Supabase auth link
      logger.warn('Could not auto-create profile (RLS):', insertError.message);
      return { handle, isNew: true };
    }

    return { handle: newProfile?.handle || handle, isNew: true };
  } catch (err) {
    logger.error('syncPrivyUserToSupabase error:', err);
    return { handle: null, isNew: false };
  }
}
