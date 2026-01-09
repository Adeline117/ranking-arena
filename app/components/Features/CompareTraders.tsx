'use client'

import React, { memo } from 'react'
import Link from 'next/link'
import { tokens } from '@/lib/design-tokens'
import { formatNumber, formatPercent } from '@/lib/design-system-helpers'
import { Box, Text, Button } from '../Base'

// Trader type - should match the type used in RankingTable
type Trader = {
  id: string
  handle: string | null
  roi: number
  win_rate: number
  followers: number
}

type CompareTradersProps = {
  traders: Trader[]
  onRemove: (id: string) => void
  onClear: () => void
}

function CompareTraders({ traders, onRemove, onClear }: CompareTradersProps) {
  if (traders.length === 0) return null

  return (
    <Box
      style={{
        position: 'fixed',
        bottom: tokens.spacing[5],
        right: tokens.spacing[5],
        background: tokens.colors.bg.secondary,
        border: `1px solid ${tokens.colors.border.primary}`,
        borderRadius: tokens.radius.xl,
        padding: tokens.spacing[4],
        boxShadow: tokens.shadow.lg,
        zIndex: tokens.zIndex.modal,
        maxWidth: '600px',
        maxHeight: '400px',
        overflow: 'auto',
        backdropFilter: 'blur(10px)',
        transition: `all ${tokens.transition.base}`,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.xl
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.boxShadow = tokens.shadow.lg
      }}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[3] }}>
        <Text size="md" weight="bold">
          对比交易者 ({traders.length})
        </Text>
        <Button
          variant="text"
          size="sm"
          onClick={onClear}
          style={{
            color: tokens.colors.text.secondary,
            fontSize: tokens.typography.fontSize.xs,
            padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          }}
        >
          清空
        </Button>
      </Box>

      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: tokens.spacing[3] }}>
        {traders.map((trader) => (
          <Box
            key={trader.id}
            style={{
              padding: tokens.spacing[3],
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              position: 'relative',
              transition: `all ${tokens.transition.base}`,
              cursor: 'pointer',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-2px)'
              e.currentTarget.style.boxShadow = tokens.shadow.md
              e.currentTarget.style.borderColor = tokens.colors.border.secondary || tokens.colors.border.primary
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)'
              e.currentTarget.style.boxShadow = tokens.shadow.none
              e.currentTarget.style.borderColor = tokens.colors.border.primary
            }}
          >
            <Button
              variant="text"
              size="sm"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(trader.id)
              }}
              style={{
                position: 'absolute',
                top: tokens.spacing[2],
                right: tokens.spacing[2],
                width: '24px',
                height: '24px',
                borderRadius: tokens.radius.full,
                background: tokens.colors.accent?.error ? `${tokens.colors.accent.error}20` : 'rgba(255, 77, 77, 0.2)',
                border: 'none',
                color: tokens.colors.accent?.error || '#ff4d4d',
                fontSize: tokens.typography.fontSize.sm,
                display: 'grid',
                placeItems: 'center',
                padding: 0,
                minWidth: '24px',
              }}
            >
              ×
            </Button>
            <Link href={`/trader/${trader.handle || trader.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
              <Text size="sm" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {trader.handle || trader.id}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                <Text size="xs" color="secondary">
                  ROI: <span style={{ color: trader.roi >= 0 ? (tokens.colors.accent?.success || '#2fe57d') : (tokens.colors.accent?.error || '#ff4d4d') }}>
                    {formatPercent(trader.roi)}
                  </span>
                </Text>
                <Text size="xs" color="secondary">
                  胜率: {Math.round(trader.win_rate)}%
                </Text>
                <Text size="xs" color="secondary">
                  粉丝: {formatNumber(trader.followers)}
                </Text>
              </Box>
            </Link>
          </Box>
        ))}
      </Box>
    </Box>
  )
}

export default memo(CompareTraders)
