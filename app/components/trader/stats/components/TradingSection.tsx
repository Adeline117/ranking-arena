'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../../base'
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

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px rgba(0, 0, 0, 0.08)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[5] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          Trading
        </Text>
      </Box>

      {trading && (trading.totalTrades12M > 0 || trading.profitableTradesPct > 0) ? (
        <Box
          className="trading-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: tokens.spacing[4],
            marginBottom: tokens.spacing[6],
          }}
        >
          <MiniKpi label="Total Trades (90D)" value={trading.totalTrades12M > 0 ? String(trading.totalTrades12M) : 'N/A'} />
          <MiniKpi
            label="Avg. Profit / Loss"
            value={trading.avgProfit > 0 || trading.avgLoss < 0
              ? `${trading.avgProfit.toFixed(2)}% / ${trading.avgLoss.toFixed(2)}%`
              : 'N/A'
            }
          />
          <MiniKpi label="Profitable Trades" value={trading.profitableTradesPct > 0 ? `${trading.profitableTradesPct.toFixed(2)}%` : 'N/A'} />
        </Box>
      ) : (
        <Box style={{
          padding: tokens.spacing[6],
          textAlign: 'center',
          marginBottom: tokens.spacing[6],
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}>
          <Text size="sm" color="tertiary">
            交易统计数据暂不可用
          </Text>
        </Box>
      )}

      {positionHistory.length > 0 && (
        <PositionHistorySection positionHistory={positionHistory} t={t} />
      )}

      {/* Additional Stats */}
      <Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[4] }}>
          <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
            Additional stats
          </Text>
        </Box>
        <Box className="trading-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacing[4] }}>
          <MiniKpi
            label={t('avgHoldingTime')}
            value={additionalStats?.avgHoldingTime || 'N/A'}
          />
          <MiniKpi
            label={t('maxDrawdown')}
            value={additionalStats?.maxDrawdown !== undefined ? `-${Math.abs(additionalStats.maxDrawdown).toFixed(2)}%` : 'N/A'}
            highlight={additionalStats?.maxDrawdown !== undefined}
            isNegative
          />
          <MiniKpi
            label="Tracked since"
            value={additionalStats?.activeSince || 'N/A'}
          />
        </Box>
      </Box>
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
          color: value === 'N/A'
            ? tokens.colors.text.tertiary
            : (highlight && isNegative ? tokens.colors.accent.error : tokens.colors.text.primary),
          fontFamily: value !== 'N/A' && !value.includes('/') ? tokens.typography.fontFamily.mono.join(', ') : 'inherit',
        }}
      >
        {value}
      </Text>
    </Box>
  )
}
