'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'

// ============================================
// 统计卡片组件
// ============================================

export function StatCard({ label, value, color, subText }: {
  label: string
  value: string
  color?: string
  subText?: string
}) {
  return (
    <Box style={{
      flex: '1 1 140px',
      padding: tokens.spacing[3],
      background: tokens.colors.bg.secondary,
      borderRadius: tokens.radius.lg,
      minWidth: 0,
    }}>
      <Text size="xs" color="tertiary" style={{ marginBottom: 4 }}>{label}</Text>
      <Text size="lg" weight="bold" style={{ color: color || tokens.colors.text.primary }}>
        {value}
      </Text>
      {subText && (
        <Text size="xs" color="tertiary" style={{ marginTop: 2 }}>{subText}</Text>
      )}
    </Box>
  )
}

// ============================================
// 排序按钮组件
// ============================================

export function SortButton({ label, active, onClick }: {
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: `${tokens.spacing[1]} ${tokens.spacing[3]}`,
        borderRadius: tokens.radius.full,
        border: 'none',
        cursor: 'pointer',
        fontSize: tokens.typography.fontSize.xs,
        fontWeight: active ? 600 : 400,
        background: active ? tokens.colors.accent.brand + '20' : 'transparent',
        color: active ? tokens.colors.accent.brand : tokens.colors.text.secondary,
        transition: `all ${tokens.transition.base}`,
      }}
    >
      {label}
    </button>
  )
}

// ============================================
// ROI 显示组件（带变化趋势）
// ============================================

export function RoiDisplay({ value, label }: { value?: number; label?: string }) {
  if (value === undefined || value === null) return null
  const isPositive = value >= 0
  return (
    <Box style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      {label && <Text size="xs" color="tertiary">{label}:</Text>}
      <Text size="xs" weight="semibold" style={{
        color: isPositive ? tokens.colors.accent.success : tokens.colors.accent.error,
      }}>
        {isPositive ? '+' : ''}{value.toFixed(2)}%
      </Text>
    </Box>
  )
}
