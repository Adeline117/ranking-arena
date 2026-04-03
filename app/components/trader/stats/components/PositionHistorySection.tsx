'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import CryptoIcon from '@/app/components/common/CryptoIcon'

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

interface PositionHistorySectionProps {
  positionHistory: PositionHistoryItem[]
  t: (key: string) => string
}

export function PositionHistorySection({ positionHistory, t }: PositionHistorySectionProps) {
  const [sortBy, setSortBy] = useState<'openTime' | 'closeTime'>('openTime')
  const [expanded, setExpanded] = useState(false)
  const COLLAPSED_COUNT = 3

  const sortedHistory = [...positionHistory].sort((a, b) => {
    const dateA = new Date(a[sortBy] || 0).getTime()
    const dateB = new Date(b[sortBy] || 0).getTime()
    return dateB - dateA
  })

  const displayedHistory = expanded ? sortedHistory : sortedHistory.slice(0, COLLAPSED_COUNT)

  return (
    <Box style={{ marginBottom: tokens.spacing[6] }}>
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="lg" weight="black">{t('positionHistory')}</Text>
        </Box>
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          <Text size="xs" color="tertiary">{t('sortBy')}</Text>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'openTime' | 'closeTime')}
            style={{
              padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
              borderRadius: tokens.radius.md,
              border: `1px solid ${tokens.colors.border.primary}`,
              background: tokens.colors.bg.primary,
              color: tokens.colors.text.primary,
              fontSize: tokens.typography.fontSize.xs,
              fontWeight: tokens.typography.fontWeight.bold,
              cursor: 'pointer',
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
            }}
          >
            <option value="openTime">{t('openTime')}</option>
            <option value="closeTime">{t('closeTime')}</option>
          </select>
        </Box>
      </Box>

      <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
        {displayedHistory.map((item, idx) => (
          <PositionHistoryCard key={idx} position={item} t={t} />
        ))}
      </Box>

      {sortedHistory.length > COLLAPSED_COUNT && (
        <button
          onClick={() => setExpanded(!expanded)}
          style={{
            width: '100%',
            padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
            marginTop: tokens.spacing[3],
            borderRadius: tokens.radius.lg,
            border: `1px solid ${tokens.colors.border.primary}`,
            background: tokens.colors.bg.tertiary,
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            cursor: 'pointer',
            transition: `all ${tokens.transition.base}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            textAlign: 'center',
          }}
        >
          {expanded ? t('positionCollapse') : `${t('positionExpandAll')} (${sortedHistory.length} ${t('positionCount')})`}
        </button>
      )}
    </Box>
  )
}

// Position History Card
function PositionHistoryCard({ position, t }: { position: PositionHistoryItem; t: (key: string) => string }) {
  const isLong = position.direction === 'long'
  const isProfit = position.pnlUsd >= 0

  const formatTime = (timeStr: string) => {
    if (!timeStr) return '--'
    const date = new Date(timeStr)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatPrice = (price: number) => {
    if (!price) return '--'
    return price >= 1 ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : price.toFixed(4)
  }

  return (
    <Box
      className="position-card"
      style={{
        background: tokens.colors.bg.primary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[4],
      }}
    >
      {/* Header */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2], marginBottom: tokens.spacing[3] }}>
        <CryptoIcon symbol={position.symbol} size={28} />

        <Text size="base" weight="black" style={{ color: tokens.colors.text.primary }}>{position.symbol}</Text>

        <Box style={{ display: 'flex', gap: tokens.spacing[1], marginLeft: 'auto' }}>
          <Box style={{
            padding: `2px 8px`,
            borderRadius: tokens.radius.full,
            background: tokens.colors.bg.tertiary,
          }}>
            <Text size="xs" style={{ color: tokens.colors.text.tertiary }}>
              {position.positionType === 'perpetual' ? t('positionPerpetual') : t('positionDelivery')}
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
              {isLong ? t('positionLong') : t('positionShort')}
            </Text>
          </Box>
        </Box>
      </Box>

      {/* Data Grid */}
      <Box className="trading-stats-grid trading-grid" style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: tokens.spacing[4],
      }}>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>{t('positionOpen')}</Text>
          <Text size="sm" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            {formatTime(position.openTime)}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>{t('positionOpenPrice')}</Text>
          <Text size="sm" weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            ${formatPrice(position.entryPrice)}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>{t('positionClosePrice')}</Text>
          <Text size="sm" style={{ color: tokens.colors.text.secondary, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            ${formatPrice(position.exitPrice)}
          </Text>
        </Box>
        <Box>
          <Text size="xs" color="tertiary" style={{ marginBottom: 4, display: 'block' }}>{t('positionPnl')}</Text>
          <Text
            size="sm"
            weight="black"
            style={{
              color: isProfit ? tokens.colors.accent.success : tokens.colors.accent.error,
              fontFamily: tokens.typography.fontFamily.mono.join(', '),
            }}
          >
            {isProfit ? '+' : '-'}${Math.abs(position.pnlUsd ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
