'use client'

import { Suspense } from 'react'
import DirectoryPage, { type DirectoryPageConfig } from '@/app/components/directory/DirectoryPage'

const TradingIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
  </svg>
)

const QuantIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="12" y1="4" x2="12" y2="20" />
  </svg>
)

const CodeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
  </svg>
)

const ToolIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
  </svg>
)

const CATEGORY_GROUPS: Record<string, string[]> = {
  analytics: ['on-chain-analytics', 'defi-analytics', 'portfolio-tracker', 'whale-tracking', 'sentiment'],
  wallets: ['hot-wallet', 'hardware-wallet', 'multisig', 'mpc-wallet', 'smart-wallet', 'wallet-infra'],
  'dev-tools': ['rpc-node', 'indexer', 'api', 'testing', 'deployment', 'sdk', 'security-tool'],
  'compliance-tax': ['tax', 'compliance-tool', 'accounting'],
  info: ['news-aggregator', 'calendar', 'alert'],
}

const config: DirectoryPageConfig = {
  table: 'tools',
  extraColumns: 'github_url, pricing',
  categoryFilters: [
    { key: 'all', labelKey: 'toolsCatAll' },
    { key: 'trading_tool', labelKey: 'toolsCatTradingTool' },
    { key: 'trading-bot', labelKey: 'toolsCatTradingBot' },
    { key: 'copytrading', labelKey: 'toolsCatCopytrading' },
    { key: 'quant_platform', labelKey: 'toolsCatQuantPlatform' },
    { key: 'analytics', labelKey: 'toolsCatAnalytics', isGroup: true },
    { key: 'wallets', labelKey: 'toolsCatWallets', isGroup: true },
    { key: 'dev-tools', labelKey: 'toolsCatDevTools', isGroup: true },
    { key: 'compliance-tax', labelKey: 'toolsCatComplianceTax', isGroup: true },
    { key: 'info', labelKey: 'toolsCatInfo', isGroup: true },
    { key: 'strategy', labelKey: 'toolsCatStrategy' },
    { key: 'script', labelKey: 'toolsCatScript' },
    { key: 'charting', labelKey: 'toolsCatCharting' },
    { key: 'signal', labelKey: 'toolsCatSignal' },
  ],
  categoryGroups: CATEGORY_GROUPS,
  sortOptions: [
    { key: 'rating', labelKey: 'toolsSortRating' },
    { key: 'newest', labelKey: 'toolsSortNewest' },
    { key: 'reviews', labelKey: 'toolsSortReviews' },
  ],
  pricingLabelKeys: {
    free: 'toolsPricingFree',
    freemium: 'toolsPricingFreemium',
    paid: 'toolsPricingPaid',
    open_source: 'toolsPricingOpenSource',
  },
  leaderboards: [
    {
      title: 'top10TradingTools',
      icon: <TradingIcon />,
      categories: ['trading_tool', 'trading-bot', 'copytrading', 'charting', 'signal'],
    },
    {
      title: 'top10QuantPlatforms',
      icon: <QuantIcon />,
      categories: ['quant_platform', 'quant-framework'],
    },
    {
      title: 'top10Scripts',
      icon: <CodeIcon />,
      orFilter: 'category.eq.script,category.eq.strategy',
    },
  ],
  header: {
    titleKey: 'tools',
    subtitleKey: 'discoverRateTools',
    icon: <ToolIcon />,
    gradient: 'var(--color-tools-gradient)',
    accentVar: 'var(--color-tools-accent)',
    accentMutedVar: 'var(--color-tools-accent-muted)',
  },
  i18n: {
    searchPlaceholder: 'searchTools',
    emptyText: 'noToolsFound',
  },
}

export default function ToolsPage() {
  return (
    <Suspense>
      <DirectoryPage config={config} />
    </Suspense>
  )
}
