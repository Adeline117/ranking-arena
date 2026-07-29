import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/supabase/database.types'
import type { SubscriptionTier } from '@/lib/types/premium'

type CanonicalEntitlementClient = Pick<SupabaseClient<Database>, 'rpc'>

/**
 * Read the same fail-closed Pro authority used by database write guards.
 *
 * Mutable `subscriptions.tier` and profile columns are projections. They can
 * briefly lag a refund, expiration, trial revocation, or another authority
 * change, so server-side feature gates must not authorize directly from them.
 */
export async function hasCurrentGlobalProEntitlement(
  supabase: CanonicalEntitlementClient,
  actorId: string
): Promise<boolean> {
  const { data, error } = await supabase.rpc('service_actor_has_current_global_pro_entitlement', {
    p_actor_id: actorId,
  })

  if (error || typeof data !== 'boolean') {
    throw new Error('Failed to verify current Pro entitlement')
  }

  return data
}

export async function getCanonicalSubscriptionTier(
  supabase: CanonicalEntitlementClient,
  actorId: string
): Promise<SubscriptionTier> {
  return (await hasCurrentGlobalProEntitlement(supabase, actorId)) ? 'pro' : 'free'
}
