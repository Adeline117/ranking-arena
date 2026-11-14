import type { SupabaseClient } from '@supabase/supabase-js'
import { logger } from '@/lib/logger'
import type { SubscriptionTier } from '@/lib/types/premium'

export type ServerTierResult =
  | { ok: true; tier: SubscriptionTier }
  | { ok: false; reason: 'lookup_failed' }

/**
 * Resolve a user's membership tier for a server-side feature gate.
 *
 * Mirrors GET /api/subscription, which the client uses to decide whether to
 * show Pro UI: an active/trialing subscription row wins, otherwise a Pro
 * grant stored only on the profile (NFT / admin) counts. A read failure is
 * reported as such — never as "free", which would 403 a paying user.
 */
export async function resolveServerTier(
  supabase: SupabaseClient,
  userId: string
): Promise<ServerTierResult> {
  const { data: subscription, error: subscriptionError } = await supabase
    .from('subscriptions')
    .select('tier')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .maybeSingle()
  if (subscriptionError) {
    logger.error('Tier lookup failed (subscriptions)', {
      userId,
      error: subscriptionError.message,
    })
    return { ok: false, reason: 'lookup_failed' }
  }
  if (subscription) {
    // 'elite' is a legacy paid tier; every paid tier maps to Pro access.
    const paid = subscription.tier === 'pro' || subscription.tier === 'elite'
    return { ok: true, tier: paid ? 'pro' : 'free' }
  }

  const { data: profile, error: profileError } = await supabase
    .from('user_profiles')
    .select('subscription_tier')
    .eq('id', userId)
    .maybeSingle()
  if (profileError) {
    logger.error('Tier lookup failed (user_profiles)', { userId, error: profileError.message })
    return { ok: false, reason: 'lookup_failed' }
  }
  return { ok: true, tier: profile?.subscription_tier === 'pro' ? 'pro' : 'free' }
}
