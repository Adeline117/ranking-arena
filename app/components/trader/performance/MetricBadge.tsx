import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'

export interface MetricBadgeProps {
  label: string
  value: string
  highlight?: boolean
  negative?: boolean
  tooltip?: string
}

/**
 * 二级指标徽章组件
 */
export function MetricBadge({
  label,
  value,
  highlight = false,
  negative = false,
  tooltip,
}: MetricBadgeProps) {
  const isNA = value === '—'
  const color = isNA
    ? tokens.colors.text.tertiary
    : highlight
      ? tokens.colors.accent.success
      : negative
        ? tokens.colors.accent.error
        : tokens.colors.text.primary

  // Sentiment-based background tint
  const bgColor = isNA
    ? tokens.colors.bg.tertiary
    : highlight
      ? `color-mix(in srgb, ${tokens.colors.accent.success} 6%, ${tokens.colors.bg.tertiary})`
      : negative
        ? `color-mix(in srgb, ${tokens.colors.accent.error} 6%, ${tokens.colors.bg.tertiary})`
        : tokens.colors.bg.tertiary

  return (
    <Box
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 6,
        padding: `5px 12px`,
        background: bgColor,
        borderRadius: tokens.radius.full,
        border: `1px solid ${highlight ? tokens.colors.accent.success + '30' : negative ? tokens.colors.accent.error + '20' : tokens.colors.border.primary}`,
        cursor: tooltip ? 'help' : undefined,
        transition: 'border-color 0.2s ease, background 0.2s ease',
      }}
      title={tooltip}
    >
      <Text style={{ fontSize: 11, color: tokens.colors.text.tertiary, fontWeight: 500, whiteSpace: 'nowrap' }}>
        {label}
      </Text>
      <Text style={{
        fontSize: 13,
        color,
        fontWeight: 700,
        fontFamily: tokens.typography.fontFamily.mono.join(', '),
        letterSpacing: '-0.02em',
        whiteSpace: 'nowrap',
      }}>
        {isNA ? '--' : value}
      </Text>
    </Box>
  )
}
