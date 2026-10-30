/**
 * Identity of locally-granted (non-Stripe) Pro rows in `public.subscriptions`.
 *
 * Referral rewards (lib/referral/grant.ts) insert a Pro row with no Stripe
 * subscription. Such a row has no Stripe authority to reconcile against, so:
 *   - the expiry cron must downgrade it by its own `current_period_end`;
 *   - checkout must let the user upgrade to a paid plan from it.
 *
 * `plan` is free text (20260703004700) and is labelled for new grants. Older
 * grant rows have `plan = NULL`; such a row only counts as a local grant when
 * it also has no Stripe customer, so a paid row that merely lost its
 * subscription id (historic webhook column drift) is never auto-downgraded —
 * it stays on the "cannot verify" reporting path instead.
 */
export const LOCAL_PRO_GRANT_PLAN = 'referral_grant'

export interface SubscriptionIdentityRow {
  plan?: string | null
  stripe_subscription_id?: string | null
  stripe_customer_id?: string | null
}

export function isLifetimeSubscriptionRow(
  row: SubscriptionIdentityRow | null | undefined
): boolean {
  if (!row) return false
  return row.plan === 'lifetime' || (row.stripe_subscription_id ?? '').startsWith('lifetime_')
}

export function isNonStripeProGrant(row: SubscriptionIdentityRow | null | undefined): boolean {
  if (!row) return false
  if (row.stripe_subscription_id || isLifetimeSubscriptionRow(row)) return false
  if (row.plan === LOCAL_PRO_GRANT_PLAN) return true
  return row.plan == null && !row.stripe_customer_id
}
