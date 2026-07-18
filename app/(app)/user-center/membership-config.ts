/**
 * Canonical pricing source — imported by PricingPageClient, lib/stripe, etc.
 * Change prices here and they propagate everywhere.
 */
export const PRICING = {
  monthly: { price: 4.99, original: null as number | null },
  yearly: { price: 29.99, original: 59.88 },
  lifetime: { price: 49.99, spots: 200 },
}

// B2B Data API pricing (separate from Pro membership)
export const API_PRICING = {
  starter: { price: 49, dailyLimit: 10_000 },
  pro: { price: 199, dailyLimit: 0 }, // 0 = unlimited
}

// Pro features list
export const getProFeatures = (t: (key: string) => string) => [
  {
    key: 'category_ranking',
    title: t('featureCategoryRanking'),
    desc: t('featureCategoryRankingDesc'),
  },
  { key: 'trader_alerts', title: t('featureTraderAlerts'), desc: t('featureTraderAlertsDesc') },
  {
    key: 'score_breakdown',
    title: t('featureScoreBreakdown'),
    desc: t('featureScoreBreakdownDesc'),
  },
  { key: 'pro_badge', title: t('featureProBadge'), desc: t('featureProBadgeDesc') },
  {
    key: 'advanced_filter',
    title: t('featureAdvancedFilter'),
    desc: t('featureAdvancedFilterDesc'),
  },
  { key: 'trader_compare', title: t('featureTraderCompare'), desc: t('featureTraderCompareDesc') },
  { key: 'pro_groups', title: t('featureProGroups'), desc: t('featureProGroupsDesc') },
  {
    key: 'historical_data',
    title: t('featureHistoricalData'),
    desc: t('featureHistoricalDataDesc'),
  },
]

// Comparison row type
export interface ComparisonRow {
  feature: string
  free: string | boolean
  pro: string | boolean
}

// Comparison data
export const getComparisonData = (t: (key: string) => string): ComparisonRow[] => [
  {
    feature: t('compFeatureLeaderboard'),
    free: t('compFreeTop50'),
    pro: t('compProFullLeaderboard'),
  },
  { feature: t('compFeatureBasicFilters'), free: true, pro: true },
  { feature: t('compFeatureTraderDetails'), free: true, pro: true },
  { feature: t('compFeatureAdvancedFilters'), free: false, pro: t('compProMultiFilter') },
  { feature: t('compFeatureTraderCompare'), free: false, pro: t('compProUpTo10Traders') },
  { feature: t('compFeatureTraderAlerts'), free: false, pro: t('compProInAppEmailPush') },
  {
    feature: t('compFeatureArenaScore'),
    free: t('compFreeTotalScore'),
    pro: t('compProBreakdownPercentile'),
  },
  { feature: t('compFeatureHistoricalData'), free: t('compFree7Days'), pro: t('compPro1Year') },
  { feature: t('compFeatureProBadgeGroups'), free: false, pro: true },
]

// FAQ data
export const getFaqData = (t: (key: string) => string) => [
  { q: t('faqCancelQ'), a: t('faqCancelA') },
  { q: t('faqPaymentQ'), a: t('faqPaymentA') },
  { q: t('faqRefundQ'), a: t('faqRefundA') },
  { q: t('faqSwitchPlanQ'), a: t('faqSwitchPlanA') },
]

/**
 * Canonical FAQ for the /pricing page (full set). Single source of truth — the
 * pricing page imports this instead of hardcoding its own array. Distinct from
 * getFaqData() above, which is the condensed FAQ shown on the user-center
 * membership panel. All keys live in lib/i18n (pricingFaq*).
 */
export const getPricingFaqData = (t: (key: string) => string) => [
  { q: t('pricingFaqCancelQ'), a: t('pricingFaqCancelA') },
  { q: t('pricingFaqRefundQ'), a: t('pricingFaqRefundA') },
  { q: t('pricingFaqLifetimeQ'), a: t('pricingFaqLifetimeA') },
  { q: t('pricingFaqPaymentQ'), a: t('pricingFaqPaymentA') },
  { q: t('pricingFaqTrialQ'), a: t('pricingFaqTrialA') },
  { q: t('pricingFaqSwitchQ'), a: t('pricingFaqSwitchA') },
  { q: t('pricingFaqApiQ'), a: t('pricingFaqApiA') },
]

/**
 * Canonical Free-vs-Pro comparison for the /pricing page (full set). Single
 * source of truth — the pricing page imports this instead of hardcoding rows.
 * Distinct from getComparisonData() above (condensed, descriptive cells) shown
 * on the user-center membership panel. Keys live in lib/i18n (pricingCompare*).
 */
export const getPricingComparisonData = (t: (key: string) => string): ComparisonRow[] => [
  { feature: t('pricingCompareTraderRankings'), free: t('compFreeTop50'), pro: true },
  { feature: t('pricingCompareAdvancedFilters'), free: false, pro: true },
  { feature: t('pricingCompareScoreBreakdown'), free: false, pro: true },
  { feature: t('pricingCompareTraderComparison'), free: false, pro: true },
  { feature: t('pricingCompareCategoryRankings'), free: false, pro: true },
  { feature: t('pricingCompareCsvExport'), free: false, pro: true },
  { feature: t('pricingCompareTraderAlerts'), free: false, pro: true },
  { feature: t('pricingCompareCommunityPosts'), free: true, pro: true },
  { feature: t('pricingComparePublicGroups'), free: true, pro: true },
  { feature: t('pricingCompareMarketOverview'), free: true, pro: true },
]

export interface MembershipInfo {
  subscription: {
    tier: 'free' | 'pro'
    status: string
    plan?: string
    currentPeriodEnd?: string
    cancelAtPeriodEnd?: boolean
  } | null
  nft: {
    hasNft: boolean
    tokenId?: string
    walletAddress?: string
    expiresAt?: string
  } | null
  usage: {
    followedTraders: number
    apiCallsToday: number
  }
}

export type PlanType = 'monthly' | 'yearly' | 'lifetime'
