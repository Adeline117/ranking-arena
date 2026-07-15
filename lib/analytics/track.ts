/**
 * Custom event tracking utility — dual-emits to Plausible AND PostHog.
 *
 * Safe to call anywhere: no-ops for whichever provider is not loaded. Both are
 * key-gated (Plausible via its script tag, PostHog via NEXT_PUBLIC_POSTHOG_KEY),
 * so with no keys set this is a silent no-op. The moment the owner adds a
 * PostHog key, every trackEvent call already sprinkled through the app starts
 * flowing into PostHog funnels with zero further code changes.
 */

type EventProps = Record<string, string | number | boolean>

/**
 * Canonical product event names.
 *
 * Keep this catalog deliberately small and journey-oriented. Adding a new
 * event requires naming the user action here first, preventing silent spelling
 * drift across Plausible and PostHog dashboards.
 */
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

interface PlausibleFn {
  (name: string, opts?: { props: Record<string, string | number | boolean> }): void
}

interface PostHogLike {
  capture: (name: string, props?: Record<string, unknown>) => void
}

export function trackEvent(name: AnalyticsEventName, props?: EventProps) {
  if (typeof window === 'undefined') return

  // Plausible
  const plausible = (window as unknown as { plausible?: PlausibleFn }).plausible
  if (plausible) {
    plausible(name, { props: props ?? {} })
  }

  // PostHog (posthog-js attaches itself to window.posthog after init)
  const posthog = (window as unknown as { posthog?: PostHogLike }).posthog
  if (posthog && typeof posthog.capture === 'function') {
    posthog.capture(name, props)
  }
}
