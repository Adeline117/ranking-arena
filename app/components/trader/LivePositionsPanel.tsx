'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import { useTraderPositionsRealtime } from '@/lib/hooks/useTraderPositionsRealtime'
import type { TraderPositionLive } from '@/lib/types/trader'

export interface LivePositionsPanelProps {
  platform: string
  traderKey: string
  isPro?: boolean
}

/**
 * LivePositionsPanel - Real-time position display
 *
 * Shows trader's current open positions with live updates.
 * Requires Pro subscription for access.
 */
export default function LivePositionsPanel({
  platform,
  traderKey,
  isPro = false,
}: LivePositionsPanelProps) {
  const { t } = useLanguage()
  const [expanded, setExpanded] = useState(true)

  const {
    positions,
    isLoading,
    status,
    totalUnrealizedPnl,
    positionCount,
    longCount,
    shortCount,
    recentUpdates,
  } = useTraderPositionsRealtime({
    platform,
    traderKey,
    enabled: isPro,
  })

  // Pro-only content gate
  if (!isPro) {
    return (
      <Box
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.primary}90 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          padding: tokens.spacing[5],
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Blurred preview */}
        <Box style={{ filter: 'blur(8px)', opacity: 0.5, pointerEvents: 'none' }}>
          <Box style={{ display: 'flex', gap: tokens.spacing[3], marginBottom: tokens.spacing[4] }}>
            {[1, 2, 3].map((i) => (
              <Box
                key={i}
                style={{
                  flex: 1,
                  height: 60,
                  background: tokens.colors.bg.tertiary,
                  borderRadius: tokens.radius.lg,
                }}
              />
            ))}
          </Box>
        </Box>

        {/* Upgrade overlay */}
        <Box
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: `${tokens.colors.bg.primary}90`,
          }}
        >
          <Box
            style={{
              padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
              background: `linear-gradient(135deg, ${tokens.colors.accent.warning}20 0%, ${tokens.colors.accent.warning}10 100%)`,
              borderRadius: tokens.radius.full,
              border: `1px solid ${tokens.colors.accent.warning}40`,
              marginBottom: tokens.spacing[3],
            }}
          >
            <Text size="sm" weight="bold" style={{ color: tokens.colors.accent.warning }}>
              PRO
            </Text>
          </Box>
          <Text size="md" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
            {t('livePositionsProOnly') || 'Real-time Positions'}
          </Text>
          <Text size="sm" color="secondary" style={{ textAlign: 'center', maxWidth: 280 }}>
            {t('livePositionsProDesc') || 'Upgrade to Pro to see live positions and get instant notifications when traders open or close positions.'}
          </Text>
        </Box>
      </Box>
    )
  }

  return (
    <Box
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary} 0%, ${tokens.colors.bg.primary}90 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: tokens.spacing[4],
          borderBottom: expanded ? `1px solid ${tokens.colors.border.primary}40` : 'none',
          cursor: 'pointer',
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
          <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
            <LiveIndicator status={status} />
            <Text size="md" weight="bold">
              {t('livePositions') || 'Live Positions'}
            </Text>
          </Box>

          {/* Quick stats */}
          <Box style={{ display: 'flex', gap: tokens.spacing[2] }}>
            <QuickStat
              label={t('open') || 'Open'}
              value={positionCount.toString()}
            />
            <QuickStat
              label="L/S"
              value={`${longCount}/${shortCount}`}
            />
            <QuickStat
              label={t('pnl') || 'PnL'}
              value={formatPnl(totalUnrealizedPnl)}
              color={totalUnrealizedPnl >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error}
            />
          </Box>
        </Box>

        <svg
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke={tokens.colors.text.tertiary}
          strokeWidth="2"
          style={{
            transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
            transition: 'transform 0.2s ease',
          }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </Box>

      {/* Content */}
      {expanded && (
        <Box style={{ padding: tokens.spacing[4] }}>
          {isLoading ? (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {[1, 2, 3].map((i) => (
                <Box
                  key={i}
                  style={{
                    height: 72,
                    background: tokens.colors.bg.tertiary,
                    borderRadius: tokens.radius.lg,
                    animation: 'pulse 2s infinite',
                  }}
                />
              ))}
            </Box>
          ) : positions.length === 0 ? (
            <Box style={{ textAlign: 'center', padding: tokens.spacing[5] }}>
              <Text size="lg" style={{ marginBottom: tokens.spacing[2] }}>📭</Text>
              <Text color="secondary">
                {t('noOpenPositions') || 'No open positions'}
              </Text>
            </Box>
          ) : (
            <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[3] }}>
              {positions.map((position) => (
                <PositionRow key={position.id} position={position} />
              ))}
            </Box>
          )}

          {/* Recent updates notification */}
          {recentUpdates.length > 0 && (
            <Box
              style={{
                marginTop: tokens.spacing[4],
                paddingTop: tokens.spacing[3],
                borderTop: `1px solid ${tokens.colors.border.primary}40`,
              }}
            >
              <Text size="xs" color="tertiary" weight="bold" style={{ marginBottom: tokens.spacing[2] }}>
                {t('recentActivity') || 'Recent Activity'}
              </Text>
              <Box style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing[1] }}>
                {recentUpdates.slice(0, 3).map((update, i) => (
                  <UpdateNotification key={i} update={update} />
                ))}
              </Box>
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}

/**
 * Live connection indicator
 */
function LiveIndicator({ status }: { status: string }) {
  const isConnected = status === 'connected'
  const isConnecting = status === 'connecting' || status === 'reconnecting'

  return (
    <Box
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: isConnected
          ? tokens.colors.accent.success
          : isConnecting
            ? tokens.colors.accent.warning
            : tokens.colors.accent.error,
        boxShadow: isConnected ? `0 0 8px ${tokens.colors.accent.success}` : 'none',
        animation: isConnecting ? 'pulse 1s infinite' : 'none',
      }}
      title={status}
    />
  )
}

/**
 * Quick stat badge
 */
function QuickStat({
  label,
  value,
  color,
}: {
  label: string
  value: string
  color?: string
}) {
  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        background: tokens.colors.bg.tertiary,
        borderRadius: tokens.radius.md,
      }}
    >
      <Text size="xs" color="tertiary">{label}</Text>
      <Text
        size="xs"
        weight="bold"
        style={{
          color: color || tokens.colors.text.primary,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
        }}
      >
        {value}
      </Text>
    </Box>
  )
}

/**
 * Position row component
 */
function PositionRow({ position }: { position: TraderPositionLive }) {
  const isLong = position.side === 'long'
  const pnlColor = (position.unrealized_pnl ?? 0) >= 0
    ? tokens.colors.accent.success
    : tokens.colors.accent.error

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: tokens.spacing[3],
        background: tokens.colors.bg.tertiary + '60',
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {/* Symbol & Side */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <Box
          style={{
            padding: '4px 8px',
            background: isLong ? `${tokens.colors.accent.success}15` : `${tokens.colors.accent.error}15`,
            borderRadius: tokens.radius.md,
            border: `1px solid ${isLong ? tokens.colors.accent.success : tokens.colors.accent.error}30`,
          }}
        >
          <Text
            size="xs"
            weight="bold"
            style={{ color: isLong ? tokens.colors.accent.success : tokens.colors.accent.error }}
          >
            {isLong ? 'LONG' : 'SHORT'}
          </Text>
        </Box>
        <Box>
          <Text weight="bold" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            {position.symbol}
          </Text>
          <Text size="xs" color="tertiary">
            {position.leverage}x
          </Text>
        </Box>
      </Box>

      {/* Entry & Current Price */}
      <Box style={{ textAlign: 'right' }}>
        <Text size="xs" color="tertiary">Entry</Text>
        <Text size="sm" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
          ${position.entry_price.toLocaleString()}
        </Text>
      </Box>

      {position.current_price && (
        <Box style={{ textAlign: 'right' }}>
          <Text size="xs" color="tertiary">Current</Text>
          <Text size="sm" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            ${position.current_price.toLocaleString()}
          </Text>
        </Box>
      )}

      {/* Unrealized PnL */}
      <Box style={{ textAlign: 'right', minWidth: 80 }}>
        <Text size="xs" color="tertiary">PnL</Text>
        <Text
          size="sm"
          weight="bold"
          style={{
            color: pnlColor,
            fontFamily: tokens.typography.fontFamily.mono.join(', '),
          }}
        >
          {formatPnl(position.unrealized_pnl ?? 0)}
        </Text>
        {position.unrealized_pnl_pct !== null && (
          <Text size="xs" style={{ color: pnlColor }}>
            {position.unrealized_pnl_pct >= 0 ? '+' : ''}
            {position.unrealized_pnl_pct.toFixed(2)}%
          </Text>
        )}
      </Box>
    </Box>
  )
}

/**
 * Update notification component
 */
function UpdateNotification({ update }: { update: { type: string; position: TraderPositionLive } }) {
  const { type, position } = update
  const icons = { open: '🟢', update: '🔄', close: '🔴' }
  const labels = { open: 'Opened', update: 'Updated', close: 'Closed' }

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
        padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
        background: tokens.colors.bg.tertiary + '40',
        borderRadius: tokens.radius.md,
      }}
    >
      <span style={{ fontSize: 12 }}>{icons[type as keyof typeof icons]}</span>
      <Text size="xs" color="secondary">
        {labels[type as keyof typeof labels]} <strong>{position.symbol}</strong> {position.side}
      </Text>
    </Box>
  )
}

/**
 * Format PnL value
 */
function formatPnl(value: number): string {
  const sign = value >= 0 ? '+' : ''
  const absValue = Math.abs(value)
  if (absValue >= 1000000) {
    return `${sign}$${(value / 1000000).toFixed(2)}M`
  } else if (absValue >= 1000) {
    return `${sign}$${value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }
  return `${sign}$${value.toFixed(2)}`
}
