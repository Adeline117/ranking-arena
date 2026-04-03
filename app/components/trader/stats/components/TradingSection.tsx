'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t as i18nT } from '@/lib/i18n'
import { NULL_DISPLAY } from '@/lib/utils/format'
import { Box, Text } from '@/app/components/base'
import type { TraderStats } from '@/lib/data/trader'
import { PositionHistorySection } from './PositionHistorySection'

interface PositionHistoryItem {
  symbol: string
  direction: string
  positionType: string
  marginMode: string
  openTime: string
  closeTime: string
  entryPrice: number
  exitPrice: number
  maxPositionSize: number
  closedSize: number
  pnlUsd: number
  pnlPct: number
  status: string
}

interface TradingSectionProps {
  trading: TraderStats['trading']
  additionalStats: TraderStats['additionalStats']
  positionHistory: PositionHistoryItem[]
  t: (key: string) => string
  delay: number
}

export function TradingSection({
  trading,
  additionalStats,
  positionHistory,
  t,
  delay
}: TradingSectionProps) {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay])

  // 判断trading数据是否全部为空
  const hasTradingData = trading && (trading.totalTrades12M > 0 || trading.profitableTradesPct > 0)
  const hasAdditionalData = additionalStats && (
    additionalStats.avgHoldingTime ||
    additionalStats.maxDrawdown !== undefined ||
    additionalStats.activeSince
  )
  const hasPositionData = positionHistory.length > 0

  // 如果所有数据都为空，隐藏整个section
  if (!hasTradingData && !hasAdditionalData && !hasPositionData) {
    return null
  }

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {t('tradingStats')}
        </Text>
      </Box>

      {hasTradingData && (
        <Box
          className="trading-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[6],
          }}
        >
          <MiniKpi label={i18nT('totalTrades90d')} value={trading!.totalTrades12M != null ? trading!.totalTrades12M.toLocaleString('en-US') : NULL_DISPLAY} />
          <MiniKpi
            label={i18nT('avgProfitLoss')}
            value={trading!.avgProfit != null && trading!.avgLoss != null
              ? `${trading!.avgProfit.toFixed(2)}% / ${trading!.avgLoss.toFixed(2)}%`
              : NULL_DISPLAY
            }
          />
          <MiniKpi label={i18nT('profitableTradesLabel')} value={trading!.profitableTradesPct != null ? `${trading!.profitableTradesPct.toFixed(2)}%` : NULL_DISPLAY} />
        </Box>
      )}

      {positionHistory.length > 0 ? (
        <PositionHistorySection positionHistory={positionHistory} t={t} />
      ) : (
        <Box style={{
          padding: tokens.spacing[8],
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: tokens.spacing[2],
        }}>
          <Text size="sm" color="secondary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
            {t('noPositionHistory')}
          </Text>
          <Text size="xs" color="tertiary">
            {t('noPositionHistoryDesc')}
          </Text>
        </Box>
      )}

      {/* Additional Stats */}
      {hasAdditionalData && (
        <Box>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
            <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
              {i18nT('additionalStats')}
            </Text>
          </Box>
          <Box className="trading-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[4] }}>
            <MiniKpi
              label={t('avgHoldingTime')}
              value={additionalStats?.avgHoldingTime || NULL_DISPLAY}
            />
            <MiniKpi
              label={t('maxDrawdown')}
              value={additionalStats?.maxDrawdown != null && Math.abs(additionalStats.maxDrawdown) <= 100 ? (Math.abs(additionalStats.maxDrawdown) < 0.05 ? '< -0.1%' : `-${Math.abs(additionalStats.maxDrawdown).toFixed(1)}%`) : NULL_DISPLAY}
              highlight={additionalStats?.maxDrawdown != null && Math.abs(additionalStats.maxDrawdown) <= 100}
              isNegative
            />
            <MiniKpi
              label={i18nT('trackedSinceLabel')}
              value={additionalStats?.activeSince || NULL_DISPLAY}
            />
          </Box>
        </Box>
      )}
    </Box>
  )
}

// Mini KPI Component
function MiniKpi({
  label,
  value,
  highlight,
  isNegative
}: {
  label: string
  value: string
  highlight?: boolean
  isNegative?: boolean
}) {
  const [isHovered, setIsHovered] = useState(false)

  return (
    <Box
      className="metric-item"
      style={{
        background: isHovered ? `${tokens.colors.accent.primary}08` : tokens.colors.bg.primary,
        padding: tokens.spacing[4],
        borderRadius: tokens.radius.xl,
        border: `1px solid ${isHovered ? tokens.colors.accent.primary + '30' : tokens.colors.border.primary}`,
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        transform: isHovered ? 'translateY(-2px)' : 'translateY(0)',
        cursor: 'default',
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[2] }}>
        <Text size="xs" color="tertiary" style={{ fontWeight: tokens.typography.fontWeight.medium }}>
          {label}
        </Text>
      </Box>
      <Text
        size="xl"
        weight="black"
        style={{
          color: value === NULL_DISPLAY
            ? tokens.colors.text.tertiary
            : (highlight && isNegative ? tokens.colors.accent.error : tokens.colors.text.primary),
          fontFamily: (value !== NULL_DISPLAY && !value.includes('/')) ? tokens.typography.fontFamily.mono.join(', ') : 'inherit',
        }}
      >
        {value}
      </Text>
    </Box>
  )
}
