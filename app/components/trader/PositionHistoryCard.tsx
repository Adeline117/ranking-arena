'use client'

import { useState, memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'
import { Box, Text } from '../base'
import { NULL_DISPLAY } from '@/lib/utils/format'
import CryptoIcon from '@/app/components/common/CryptoIcon'
import PortfolioDataCell from './PortfolioDataCell'
import type { ExtendedPositionHistoryItem } from './portfolio-table-utils'
import { formatDateTime, formatPriceWithComma, formatSizeWithUnit } from './portfolio-table-utils'

const PositionHistoryCard = memo(function PositionHistoryCard({
  position,
  index,
}: {
  position: ExtendedPositionHistoryItem
  index: number
}) {
  const { t, language } = useLanguage()
  const [isHovered, setIsHovered] = useState(false)
  const isLong = position.direction === 'long'
  const isProfit = (position.pnlUsd ?? position.pnlPct ?? 0) >= 0
  const coinName = position.symbol.replace('USDT', '').replace('BUSD', '')

  return (
    <Box
      className="position-card"
      style={{
        background: isHovered
          ? `linear-gradient(135deg, ${tokens.colors.bg.primary}F0, ${tokens.colors.bg.secondary}E0)`
          : tokens.colors.bg.primary,
        border: `1px solid ${isHovered ? tokens.colors.accent.primary + '40' : tokens.colors.border.primary}`,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[5],
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        transform: isHovered ? 'translateY(-4px) scale(1.01)' : 'translateY(0) scale(1)',
        boxShadow: isHovered ? `0 12px 32px var(--color-overlay-light)` : 'none',
        animationDelay: `${index * 0.05}s`,
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      {/* Header */}
      <Box style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[4],
        paddingBottom: tokens.spacing[3],
        borderBottom: `1px solid ${tokens.colors.border.primary}40`,
      }}>
        <CryptoIcon symbol={coinName} size={32} />

        <Text size="base" weight="black" style={{ color: tokens.colors.text.primary }}>
          {position.symbol}
        </Text>

        {/* Tags */}
        <Box style={{ display: 'flex', gap: tokens.spacing[1], marginLeft: 'auto' }}>
          <Box style={{
            padding: `2px 8px`,
            borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary,
          }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
              {position.positionType === 'perpetual' ? t('perpetual') : t('delivery')}
            </Text>
          </Box>

          <Box style={{
            padding: `2px 10px`,
            borderRadius: tokens.radius.full,
            background: isLong ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
            border: `1px solid ${isLong ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
          }}>
            <Text size="xs" style={{
              color: isLong ? tokens.colors.accent.success : tokens.colors.accent.error,
              fontWeight: 600,
            }}>
              {position.marginMode === 'cross' ? t('crossMargin') : t('isolatedMargin')} {isLong ? t('long') : t('short')}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Data grid */}
      <Box className="trading-grid" style={{
        display: 'grid',
        gap: tokens.spacing[4],
        marginBottom: tokens.spacing[3],
      }}>
        <PortfolioDataCell label={t('openTime')} value={position.openTime ? formatDateTime(position.openTime, language) : NULL_DISPLAY} />
        <PortfolioDataCell label={t('openPrice')} value={`${formatPriceWithComma(position.entryPrice)}`} />
        <PortfolioDataCell
          label={t('closePnl')}
          value={position.pnlUsd !== undefined && position.pnlUsd !== 0
            ? `${isProfit ? '+' : '-'}$${formatPriceWithComma(Math.abs(position.pnlUsd))}`
            : `${isProfit ? '+' : ''}${(position.pnlPct ?? 0).toFixed(2)}%`
          }
          highlight
          isProfit={isProfit}
        />
      </Box>

      <Box className="trading-grid" style={{
        display: 'grid',
        gap: tokens.spacing[4],
      }}>
        <PortfolioDataCell label={t('closePrice')} value={`${formatPriceWithComma(position.exitPrice)}`} secondary />
        <PortfolioDataCell label={t('maxPosition')} value={formatSizeWithUnit(position.maxPositionSize, coinName)} secondary />
        <PortfolioDataCell label={t('closeTime')} value={position.closeTime ? formatDateTime(position.closeTime, language) : NULL_DISPLAY} secondary />
      </Box>
    </Box>
  )
})

export default PositionHistoryCard
