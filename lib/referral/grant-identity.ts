/**
 * Identity of locally-granted (non-Stripe) Pro rows in `public.subscriptions`.
 *
 * Referral rewards (lib/referral/grant.ts) insert a Pro row with no Stripe
 * subscription. Such a row has no Stripe authority to reconcile against, so:
 *   - the expiry cron must downgrade it by its own `current_period_end`;
 *   - checkout must let the user upgrade to a paid plan from it.
 *
 * `plan` is free text (20260703004700) and is labelled for new grants; older
 * grant rows have `plan = NULL`, so the durable discriminator is "no Stripe
 * subscription id and not a lifetime purchase".
 */
export const LOCAL_PRO_GRANT_PLAN = 'referral_grant'

export interface SubscriptionIdentityRow {
  plan?: string | null
  stripe_subscription_id?: string | null
}

export function isLifetimeSubscriptionRow(
  row: SubscriptionIdentityRow | null | undefined
): boolean {
  if (!row) return false
  return row.plan === 'lifetime' || (row.stripe_subscription_id ?? '').startsWith('lifetime_')
}

export function isNonStripeProGrant(row: SubscriptionIdentityRow | null | undefined): boolean {
  if (!row) return false
  return !row.stripe_subscription_id && !isLifetimeSubscriptionRow(row)
}
