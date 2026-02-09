'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'
import type { TimeRange } from './hooks/useTraderData'

interface TimeRangeSelectorProps {
  activeRange: TimeRange
  onChange: (range: TimeRange) => void
  disabled?: boolean
}

const TIME_RANGES: TimeRange[] = ['COMPOSITE', '90D', '30D', '7D']

/**
 * 时间范围选择器组件
 * 用于切换排行榜的时间范围
 */
export default function TimeRangeSelector({
  activeRange,
  onChange,
  disabled = false,
}: TimeRangeSelectorProps) {
  const { t, language } = useLanguage()

  const getLabel = (range: TimeRange): string => {
    switch (range) {
      case 'COMPOSITE':
        return language === 'zh' ? '综合' : 'Composite'
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
      className="time-range-selector"
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 3,
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {TIME_RANGES.map((range) => {
        const isActive = activeRange === range
        return (
          <button
            key={range}
            onClick={() => !disabled && onChange(range)}
            disabled={disabled}
            className="touch-target"
            style={{
              padding: `6px ${tokens.spacing[4]}`,
              minHeight: 32,
              background: isActive
                ? `${tokens.colors.accent.primary}20`
                : 'transparent',
              color: isActive
                ? tokens.colors.accent.primary
                : tokens.colors.text.tertiary,
              border: isActive
                ? `1px solid ${tokens.colors.accent.primary}60`
                : '1px solid transparent',
              borderRadius: tokens.radius.md,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: `all ${tokens.transition.fast}`,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              boxShadow: isActive
                ? '0 1px 3px rgba(0,0,0,0.08)'
                : 'none',
              lineHeight: 1,
            }}
          >
            {getLabel(range)}
          </button>
        )
      })}
    </Box>
  )
}
