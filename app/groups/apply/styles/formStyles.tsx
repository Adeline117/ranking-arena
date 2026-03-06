import React from 'react'
import { Box, Text } from '@/app/components/base'

type Tokens = typeof import('@/lib/design-tokens').tokens

export function formStyles(tokens: Tokens, t: (key: string) => string) {
  const inputStyle: React.CSSProperties = {
    width: '100%',
    padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
    borderRadius: tokens.radius.lg,
    border: ('1px solid ' + tokens.colors.border.primary),
    background: tokens.colors.bg.primary,
    color: tokens.colors.text.primary,
    fontSize: tokens.typography.fontSize.base,
    outline: 'none',
    transition: `border-color ${tokens.transition.base}`,
  }

  const labelStyle: React.CSSProperties = {
    display: 'block',
    marginBottom: tokens.spacing[2],
    fontSize: tokens.typography.fontSize.sm,
    fontWeight: tokens.typography.fontWeight.semibold,
    color: tokens.colors.text.secondary,
  }

  const tabStyle = (isActive: boolean): React.CSSProperties => ({
    padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
    borderRadius: `${tokens.radius.lg} ${tokens.radius.lg} 0 0`,
    border: `1px solid ${isActive ? tokens.colors.border.primary : 'transparent'}`,
    borderBottom: isActive ? 'none' : `1px solid ${tokens.colors.border.primary}`,
    background: isActive ? tokens.colors.bg.secondary : 'transparent',
    color: isActive ? tokens.colors.text.primary : tokens.colors.text.tertiary,
    cursor: 'pointer',
    fontWeight: isActive ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
    transition: `all ${tokens.transition.base}`,
  })

  const getStatusBadge = (status: string) => {
    const styles: Record<string, { bg: string; color: string; key: string }> = {
      pending: { bg: 'var(--color-orange-bg-light)', color: 'var(--color-accent-warning)', key: 'pendingReview' },
      approved: { bg: 'var(--color-accent-success-20)', color: 'var(--color-accent-success)', key: 'approved' },
      rejected: { bg: 'var(--color-red-bg-light)', color: 'var(--color-accent-error)', key: 'rejected' }
    }
    const style = styles[status] || styles.pending
    return (
      <Box
        as="span"
        style={{
          display: 'inline-block',
          padding: `${tokens.spacing[1]} ${tokens.spacing[2]}`,
          borderRadius: tokens.radius.md,
          background: style.bg,
          color: style.color,
          fontSize: tokens.typography.fontSize.xs,
          fontWeight: tokens.typography.fontWeight.bold,
        }}
      >
        <Text as="span" size="xs" weight="bold" style={{ color: style.color }}>
          {t(style.key)}
        </Text>
      </Box>
    )
  }

  return { inputStyle, labelStyle, tabStyle, getStatusBadge }
}
