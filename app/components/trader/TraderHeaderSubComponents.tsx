'use client'

import React from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text, Button } from '../base'
import CopyTradeButton from './CopyTradeButton'

export interface ActionButtonProps {
  onClick: () => void
  variant: 'accent' | 'ghost'
  icon?: React.ReactNode
  children: React.ReactNode
}

export function ActionButton({ onClick, variant, icon, children }: ActionButtonProps): React.ReactElement {
  const isAccent = variant === 'accent'
  const baseBackground = isAccent ? `${tokens.colors.accent.primary}15` : tokens.colors.bg.tertiary
  const baseBorder = isAccent ? `${tokens.colors.accent.primary}40` : tokens.colors.border.primary
  const textColor = isAccent ? tokens.colors.text.primary : tokens.colors.text.tertiary

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={onClick}
      style={{
        color: textColor,
        fontSize: tokens.typography.fontSize.sm,
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.lg,
        background: baseBackground,
        border: `1px solid ${baseBorder}`,
        transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[2],
      }}
      onMouseEnter={(e) => {
        if (isAccent) {
          e.currentTarget.style.background = `${tokens.colors.accent.primary}25`
          e.currentTarget.style.borderColor = tokens.colors.accent.primary
        } else {
          e.currentTarget.style.background = tokens.colors.bg.secondary
          e.currentTarget.style.borderColor = `${tokens.colors.accent.primary}40`
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = baseBackground
        e.currentTarget.style.borderColor = baseBorder
      }}
    >
      {icon}
      {children}
    </Button>
  )
}

export interface CopyTradeSectionProps {
  isPro: boolean
  traderId: string
  source?: string
  handle: string
  t: (key: string) => string
}

export function CopyTradeSection({ isPro: _isPro, traderId, source, handle, t }: CopyTradeSectionProps): React.ReactElement {
  // Only show "Go to Exchange" button — no in-app copy trading
  return (
    <Box style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
      <CopyTradeButton traderId={traderId} source={source} traderHandle={handle} />
      <Text size="xs" color="tertiary" style={{ fontSize: 11, opacity: 0.7 }}>
        {t('jumpToExchange')}
      </Text>
    </Box>
  )
}

export interface BadgeProps {
  children: React.ReactNode
  color: string
  style?: React.CSSProperties
  title?: string
}

export function Badge({ children, color, style, title }: BadgeProps): React.ReactElement {
  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: `4px ${tokens.spacing[3]}`,
        background: `${color}18`,
        borderRadius: tokens.radius.full,
        border: `1px solid ${color}40`,
        ...style,
      }}
      title={title}
    >
      {children}
    </Box>
  )
}

export interface StatItemProps {
  icon?: React.ReactNode
  value: string | number
  label: string
  hasCover: boolean
}

export function StatItem({ icon, value, label, hasCover }: StatItemProps): React.ReactElement {
  const textColor = hasCover ? 'var(--glass-bg-medium)' : tokens.colors.text.tertiary
  const valueColor = hasCover ? tokens.colors.white : tokens.colors.text.primary
  const textShadow = hasCover ? '0 1px 4px var(--color-overlay-dark)' : undefined

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.md,
      }}
    >
      {icon}
      <Text
        as="span"
        weight="bold"
        style={{
          color: valueColor,
          textShadow,
          fontSize: tokens.typography.fontSize.sm,
          fontFamily: tokens.typography.fontFamily.mono.join(', '),
          letterSpacing: '-0.01em',
        }}
      >
        {typeof value === 'number' ? value.toLocaleString() : value}
      </Text>
      <Text size="sm" style={{ color: textColor, textShadow }}>
        {label}
      </Text>
    </Box>
  )
}
