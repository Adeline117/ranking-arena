import type { SupabaseClient, User } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import { logger } from '@/lib/logger'

/**
 * Does confirming a sensitive action for this user require their password?
 *
 * Having an `email` identity is not the same as having a password: email
 * signup creates the user when the code is sent and the password is a later
 * step, so code-only users have the identity but no password and can never
 * pass a password check. The `auth_user_has_password` RPC reads the real
 * answer. OAuth-only and wallet accounts never have one.
 *
 * If the RPC is unavailable the function fails closed to the old rule (an
 * email identity demands a password) rather than weakening confirmation.
 */
export async function accountRequiresPassword(
  admin: SupabaseClient<Database>,
  user: Pick<User, 'id' | 'email' | 'identities'>
): Promise<boolean> {
  const providers = (user.identities ?? []).map((identity) => identity.provider)
  const isWalletEmail = (user.email ?? '').endsWith('@wallet.arena')
  if (isWalletEmail || !providers.includes('email')) return false

  const { data, error } = await admin.rpc('auth_user_has_password', { p_user_id: user.id })
  if (error) {
    logger.error('Password status lookup failed; requiring a password', {
      userId: user.id,
      error: error.message,
    })
    return true
  }
  return data === true
}
