'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'
import { useLanguage } from '../Utils/LanguageProvider'
import type { TimeRange } from './hooks/useTraderData'

interface TimeRangeSelectorProps {
  activeRange: TimeRange
  onChange: (range: TimeRange) => void
  disabled?: boolean
}

const TIME_RANGES: TimeRange[] = ['90D', '30D', '7D']

/**
 * 时间范围选择器组件
 * 用于切换排行榜的时间范围
 */
export default function TimeRangeSelector({
  activeRange,
  onChange,
  disabled = false,
}: TimeRangeSelectorProps) {
  const { t } = useLanguage()

  const getLabel = (range: TimeRange): string => {
    switch (range) {
      case '90D':
        return t('days90')
      case '30D':
        return t('days30')
      case '7D':
        return t('days7')
      default:
        return range
    }
  }

  return (
    <Box
      style={{
        display: 'flex',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[3],
        padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {TIME_RANGES.map((range) => (
        <button
          key={range}
          onClick={() => !disabled && onChange(range)}
          disabled={disabled}
          style={{
            flex: 1,
            padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
            background: activeRange === range ? tokens.colors.bg.primary : 'transparent',
            color: activeRange === range ? tokens.colors.text.primary : tokens.colors.text.tertiary,
            border: activeRange === range ? `1px solid ${tokens.colors.border.primary}` : '1px solid transparent',
            borderRadius: tokens.radius.md,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: activeRange === range ? tokens.typography.fontWeight.bold : tokens.typography.fontWeight.medium,
            cursor: disabled ? 'not-allowed' : 'pointer',
            opacity: disabled ? 0.5 : 1,
            transition: `all ${tokens.transition.base}`,
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
          }}
        >
          {getLabel(range)}
        </button>
      ))}
    </Box>
  )
}
