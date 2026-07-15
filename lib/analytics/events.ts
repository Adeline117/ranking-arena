/** Canonical, journey-oriented B2C product events. */
export const ANALYTICS_EVENTS = {
  landingView: 'landing_view',
  rankingVisible: 'ranking_visible',
  rankingFilter: 'ranking_filter',
  rankingSort: 'ranking_sort',
  search: 'search',
  searchResultClick: 'search_result_click',
  viewTrader: 'view_trader',
  followTrader: 'follow_trader',
  saveTrader: 'save_trader',
  savedView: 'saved_view',
  compareTrader: 'compare_trader',
  createTraderAlert: 'create_trader_alert',
  signupStart: 'signup_start',
  signup: 'signup',
  login: 'login',
  loginSwitchToCode: 'login_switch_to_code',
  loginSwitchToPassword: 'login_switch_to_password',
  loginSwitchToLogin: 'login_switch_to_login',
  loginSwitchToRegister: 'login_switch_to_register',
  onboardingStart: 'onboarding_start',
  onboardingStepComplete: 'onboarding_step_complete',
  onboardingComplete: 'onboarding_complete',
  onboardingSkip: 'onboarding_skip',
  viewPricing: 'view_pricing',
  startCheckout: 'start_checkout',
  clickFreeTrial: 'click_free_trial',
  clickUpgradeCta: 'click_upgrade_cta',
  clickGoProNav: 'click_go_pro_nav',
  proSubscribe: 'pro_subscribe',
  paywallBlocked: 'paywall_blocked',
  paywallCtaClick: 'paywall_cta_click',
  claimTrader: 'claim_trader',
  createPost: 'create_post',
  commentCreated: 'comment_created',
  postBookmark: 'post_bookmark',
  postReaction: 'post_reaction',
  postRepost: 'post_repost',
  groupJoin: 'group_join',
  share: 'share',
  tipShare: 'tip_share',
  copyReferralLink: 'copy_referral_link',
} as const

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[keyof typeof ANALYTICS_EVENTS]

const eventNames = new Set<string>(Object.values(ANALYTICS_EVENTS))

export function isAnalyticsEventName(value: string): value is AnalyticsEventName {
  return eventNames.has(value)
}
