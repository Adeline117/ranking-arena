'use client'

/**
 * PortfolioTab — extracted from TraderProfileClient.tsx to isolate
 * reconciliation scope. SWR revalidations on overview/stats tabs
 * no longer trigger a re-render of this subtree.
 */

import React from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { EXCHANGE_NAMES } from '@/lib/constants/exchanges'
import { Box, Text } from '@/app/components/base'
import { RankingSkeleton } from '@/app/components/ui/Skeleton'
import type { PortfolioItem, PositionHistoryItem } from '@/lib/data/trader-types'

const PortfolioTable = dynamic(() => import('@/app/components/trader/PortfolioTable'), {
  loading: () => <RankingSkeleton />,
})

export interface PortfolioTabProps {
  visited: boolean
  portfolio: PortfolioItem[]
  positionHistory: PositionHistoryItem[]
  source: string
  isPro: boolean
  onUnlock: () => void
}

const PortfolioTab = React.memo(function PortfolioTab({
  visited,
  portfolio,
  positionHistory,
  source,
  isPro,
  onUnlock,
}: PortfolioTabProps) {
  const { t } = useLanguage()

  if (!visited) {
    return <RankingSkeleton />
  }

  if (portfolio.length === 0 && positionHistory.length === 0) {
    return (
      <Box style={{
        padding: tokens.spacing[10],
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: tokens.spacing[3],
      }}>
        <Box style={{
          width: 48, height: 48,
          borderRadius: tokens.radius.full,
          background: `${tokens.colors.text.tertiary}10`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <svg width={24} height={24} viewBox="0 0 24 24" fill="none" stroke={tokens.colors.text.tertiary} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
            <polyline points="13 2 13 9 20 9" />
          </svg>
        </Box>
        <Text size="base" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
          {t('noPortfolioData')}
        </Text>
        {source && EXCHANGE_NAMES[source.toLowerCase()] && (
          <Text size="sm" color="tertiary">
            {t('viewOnExchange').replace('{exchange}', EXCHANGE_NAMES[source.toLowerCase()])}
          </Text>
        )}
      </Box>
    )
  }

  return (
    <PortfolioTable
      items={portfolio}
      history={positionHistory}
      isPro={isPro}
      onUnlock={onUnlock}
    />
  )
})

export default PortfolioTab
