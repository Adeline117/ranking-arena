/**
 * Legacy referral-program constants retained for historical data compatibility.
 * The fixed V1 publication hold disables new referral invitations and rewards;
 * these values must not be used to advertise, calculate, or promise a V1
 * referral reward in UI copy.
 *
 * COST-SENSITIVE: these values directly control free Pro grants and therefore
 * real billing exposure. Any change here is a cost decision — review carefully.
 */

/** Legacy number of referrals that formerly qualified an advocate reward. */
export const REFERRAL_REWARD_THRESHOLD = 3

/** Legacy Pro-day amount; V1 does not issue this reward. */
export const REFERRAL_ADVOCATE_PRO_DAYS = 30

/**
 * Legacy referred-friend trial amount. V1 attribution does not issue this
 * trial or any other referral reward.
 *
 * Historical compatibility only; it is not a runtime publication switch.
 */
export const REFERRED_FRIEND_TRIAL_DAYS = 7

/**
 * Legacy anti-farming cap, retained because historic attribution records may
 * reference the same policy. It does not enable a V1 friend trial or advocate
 * reward.
 */
export const REFERRAL_FRIEND_GRANTS_PER_DEVICE = 3

/**
 * Legacy qualification window retained for historic data interpretation. The
 * V1 `qualify-referrals` ingress is unavailable, so no automatic grant follows
 * from this value.
 */
export const REFERRAL_QUALIFY_MIN_AGE_HOURS = 24

/**
 * Legacy velocity-monitoring window retained for historic policy context. It
 * does not activate monitoring, qualification, or rewards during the V1 hold.
 */
export const REFERRAL_VELOCITY_ALERT_MINUTES = 60
