/**
 * Shared referral-program constants — single source of truth so the server-side
 * grant logic (`app/api/referral/apply/route.ts`) and the UI copy / progress
 * indicators (`/referral`, profile ReferralCard) can never drift apart.
 *
 * COST-SENSITIVE: these values directly control free Pro grants and therefore
 * real billing exposure. Any change here is a cost decision — review carefully.
 */

/** Number of successful referrals an advocate needs to earn the reward. */
export const REFERRAL_REWARD_THRESHOLD = 3

/** Days of Pro granted to the ADVOCATE once they reach the threshold. */
export const REFERRAL_ADVOCATE_PRO_DAYS = 30

/**
 * Days of Pro trial granted to the REFERRED FRIEND on successful attribution
 * (the double-sided reward). This is a PER-SIGNUP cost.
 *
 * KILL SWITCH: set to 0 to disable the friend-side reward entirely. The grant
 * is idempotent (it only fires inside the one-time `/api/referral/apply`
 * success path, which rejects a second apply once `referred_by` is set).
 */
export const REFERRED_FRIEND_TRIAL_DAYS = 7

/**
 * Anti-farming cap: max friend trials granted to signups sharing one device
 * fingerprint (hashed IP+UA bucket). Prevents one attacker from harvesting N
 * friend trials by spinning up throwaway accounts on the same machine. Set high
 * enough to tolerate shared networks (family/office/NAT), low enough to blunt
 * mass farming. The advocate threshold separately counts DISTINCT devices, so a
 * same-device farm collapses to one referral toward the advocate reward.
 */
export const REFERRAL_FRIEND_GRANTS_PER_DEVICE = 3

/**
 * Deferred qualification: a referral only earns rewards once the referred
 * account shows real activity. Rewards are NOT granted at apply time — the
 * qualify-referrals cron grants them after the account qualifies:
 *   onboarding_completed = true AND (linked a trader OR account age ≥ this many hours).
 * This keeps throwaway/farm accounts (which never onboard or age) from ever
 * earning the friend trial or counting toward the advocate threshold.
 */
export const REFERRAL_QUALIFY_MIN_AGE_HOURS = 24

/**
 * Velocity monitoring (log-only, non-blocking): if a referrer's qualifying
 * referrals all land within this window, it's a burst worth a human look
 * (possible cross-device / patient farm that the device + activity gates don't
 * catch). We LOG a structured warning rather than auto-block — blocking on
 * velocity risks false-positiving a genuinely viral referrer. Tune / wire to an
 * alert channel as needed.
 */
export const REFERRAL_VELOCITY_ALERT_MINUTES = 60
