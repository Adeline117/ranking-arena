/**
 * GoTrue ban applied while an account is pending deletion.
 *
 * It must outlive the 30-day grace period: a 720h ban expired exactly when
 * the grace ended, so a not-yet-purged account could sign in again and then
 * hit "Account suspended" on every API call (server auth still sees
 * deleted_at). Recovery lifts the ban explicitly (ban_duration: 'none') and
 * the purge job deletes the auth user, so neither depends on expiry.
 */
export const PENDING_DELETION_BAN_DURATION = '876000h'

/**
 * Subscription statuses whose renewal deletion stops and recovery resumes.
 * Both routes must use the same set, or a past_due subscription stays set to
 * cancel after the account is recovered.
 */
export const RENEWABLE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due'] as const
