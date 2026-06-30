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
