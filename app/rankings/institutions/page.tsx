'use client'

import { Suspense } from 'react'
import DirectoryPage, { type DirectoryPageConfig } from '@/app/components/directory/DirectoryPage'
import { tokens } from '@/lib/design-tokens'

const FundIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="1" x2="12" y2="23" /><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)

const ProjectIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="2" y="7" width="20" height="14" rx="2" ry="2" /><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </svg>
)

const ExchangeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" /><polyline points="17 6 23 6 23 12" />
  </svg>
)

const BuildingIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="2" width="16" height="20" rx="2" ry="2" /><path d="M9 22v-4h6v4" /><line x1="8" y1="6" x2="10" y2="6" /><line x1="14" y1="6" x2="16" y2="6" /><line x1="8" y1="10" x2="10" y2="10" /><line x1="14" y1="10" x2="16" y2="10" /><line x1="8" y1="14" x2="10" y2="14" /><line x1="14" y1="14" x2="16" y2="14" />
  </svg>
)

const CATEGORY_GROUPS: Record<string, string[]> = {
  defi: ['defi-lending', 'defi-stablecoin', 'liquid-staking', 'restaking', 'defi-yield', 'defi-cdp', 'defi-derivatives', 'defi-insurance'],
  services: ['custody', 'compliance', 'audit', 'market-maker', 'prime-broker', 'banking', 'legal', 'accounting', 'insurance-provider', 'payroll', 'fund-admin'],
  media: ['media', 'podcast', 'research', 'data-provider', 'newsletter', 'education'],
}

const config: DirectoryPageConfig = {
  table: 'institutions',
  categoryFilters: [
    { key: 'all', labelKey: 'instCatAll' },
    { key: 'exchange', labelKey: 'instCatExchange' },
    { key: 'cex', labelKey: 'instCatCex' },
    { key: 'dex', labelKey: 'instCatDex' },
    { key: 'derivatives', labelKey: 'instCatDerivatives' },
    { key: 'dex-aggregator', labelKey: 'instCatDexAggregator' },
    { key: 'otc', labelKey: 'instCatOtc' },
    { key: 'fund', labelKey: 'instCatFund' },
    { key: 'crypto-vc', labelKey: 'instCatCryptoVc' },
    { key: 'traditional-vc', labelKey: 'instCatTraditionalVc' },
    { key: 'hedge-fund', labelKey: 'instCatHedgeFund' },
    { key: 'family-office', labelKey: 'instCatFamilyOffice' },
    { key: 'trading-firm', labelKey: 'instCatTradingFirm' },
    { key: 'dao-treasury', labelKey: 'instCatDaoTreasury' },
    { key: 'accelerator', labelKey: 'instCatAccelerator' },
    { key: 'l1', labelKey: 'instCatL1' },
    { key: 'l2', labelKey: 'instCatL2' },
    { key: 'project', labelKey: 'instCatProject' },
    { key: 'defi', labelKey: 'instCatDefi', isGroup: true },
    { key: 'infrastructure', labelKey: 'instCatInfrastructure' },
    { key: 'services', labelKey: 'instCatServices', isGroup: true },
    { key: 'media', labelKey: 'instCatMedia', isGroup: true },
  ],
  categoryGroups: CATEGORY_GROUPS,
  sortOptions: [
    { key: 'rating', labelKey: 'instSortRating' },
    { key: 'newest', labelKey: 'instSortNewest' },
    { key: 'reviews', labelKey: 'instSortReviews' },
  ],
  leaderboards: [
    {
      title: 'top10Funds',
      icon: <FundIcon />,
      categories: ['fund', 'crypto-vc', 'traditional-vc', 'hedge-fund', 'trading-firm', 'family-office', 'accelerator', 'dao-treasury'],
    },
    {
      title: 'top10Projects',
      icon: <ProjectIcon />,
      categories: ['project', 'l1', 'l2', ...CATEGORY_GROUPS.defi],
    },
    {
      title: 'top10Exchanges',
      icon: <ExchangeIcon />,
      categories: ['exchange', 'cex', 'dex', 'derivatives', 'dex-aggregator', 'otc'],
    },
  ],
  header: {
    titleKey: 'institutions',
    subtitleKey: 'discoverRateInstitutions',
    icon: <BuildingIcon />,
    gradient: tokens.gradient.purpleGold,
  },
  i18n: {
    searchPlaceholder: 'searchInstitutions',
    emptyText: 'noInstitutionsFound',
    noRatingsYet: 'instNoRatingsYet',
  },
}

export default function InstitutionsPage() {
  return (
    <Suspense>
      <DirectoryPage config={config} />
    </Suspense>
  )
}
