'use client'

import { tokens } from '@/lib/design-tokens'
import { Box } from '../Base'
import { useLanguage } from '../Providers/LanguageProvider'
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
      className="time-range-selector"
      style={{
        display: 'flex',
        gap: 4,
        marginBottom: tokens.spacing[4],
        padding: 4,
        background: tokens.glass.bg.light,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
        backdropFilter: tokens.glass.blur.sm,
        WebkitBackdropFilter: tokens.glass.blur.sm,
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
              flex: 1,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              minHeight: 44,
              background: isActive 
                ? tokens.gradient.primary
                : 'transparent',
              color: isActive 
                ? '#ffffff' 
                : tokens.colors.text.tertiary,
              border: 'none',
              borderRadius: tokens.radius.lg,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive 
                ? tokens.typography.fontWeight.black 
                : tokens.typography.fontWeight.semibold,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: `all ${tokens.transition.base}`,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              boxShadow: isActive 
                ? `0 4px 12px ${tokens.colors.accent.primary}40` 
                : 'none',
              transform: isActive ? 'scale(1)' : 'scale(1)',
            }}
          >
            {getLabel(range)}
          </button>
        )
      })}
    </Box>
  )
}
