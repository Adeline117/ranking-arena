'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

/* ── Module-level variant style constants ──
   Avoids creating new style objects on every Card render. */
const VARIANT_STYLES: Record<string, React.CSSProperties> = {
  glass: {
    background: tokens.glass.bg.secondary,
    backdropFilter: tokens.glass.blur.lg,
    WebkitBackdropFilter: tokens.glass.blur.lg,
    border: tokens.glass.border.light,
  },
  outline: {
    background: 'transparent',
    border: `1px solid ${tokens.colors.border.primary}`,
  },
  elevated: {
    background: tokens.colors.bg.secondary,
    boxShadow: 'var(--shadow-elevated), var(--shadow-inset-subtle)',
    border: 'none',
  },
  default: {
    background: tokens.colors.bg.secondary,
    border: `1px solid ${tokens.colors.border.primary}`,
    boxShadow: 'var(--shadow-card), var(--shadow-inset-subtle)',
  },
}

const ACCENT_BAR_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  right: 0,
  height: 3,
  background: tokens.gradient.primary,
  borderRadius: `${tokens.radius.xl} ${tokens.radius.xl} 0 0`,
}

export interface CardProps {
  title?: string
  subtitle?: string
  children: React.ReactNode
  variant?: 'default' | 'glass' | 'outline' | 'elevated'
  padding?: 'sm' | 'md' | 'lg'
  hoverable?: boolean
  accent?: boolean
  className?: string
  style?: React.CSSProperties
  onClick?: () => void
}

export default memo(function Card({
  title,
  subtitle,
  children,
  variant = 'default',
  padding = 'md',
  hoverable = true,
  accent = false,
  className = '',
  style,
  onClick,
}: CardProps) {
  const paddingValue = {
    sm: 3,
    md: 4,
    lg: 6,
  }[padding] as 3 | 4 | 6

  const hoverClass = hoverable
    ? variant === 'glass' ? 'glass-card' : 'card-hover'
    : ''

  return (
    <Box
      className={`${hoverClass} ${className}`}
      p={paddingValue}
      radius="xl"
      style={{
        ...VARIANT_STYLES[variant],
        cursor: onClick ? 'pointer' : undefined,
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
      onClick={onClick}
    >
      {/* Accent top border */}
      {accent && <div style={ACCENT_BAR_STYLE} />}
      
      {/* Header */}
      {(title || subtitle) && (
        <div style={{ marginBottom: tokens.spacing[4] }}>
          {title && (
            <Text size="md" weight="semibold" style={{ marginBottom: subtitle ? tokens.spacing[1] : 0 }}>
              {title}
            </Text>
          )}
          {subtitle && (
            <Text size="sm" color="tertiary">
              {subtitle}
            </Text>
          )}
        </div>
      )}
      
      {children}
    </Box>
  )
})
