'use client'

import { useRef, useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box } from '../base'
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
 * 使用滑动指示器实现平滑切换动画
 */
export default function TimeRangeSelector({
  activeRange,
  onChange,
  disabled = false,
}: TimeRangeSelectorProps) {
  const { t, language } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number } | null>(null)
  const hasInitialized = useRef(false)

  const getLabel = (range: TimeRange): string => {
    switch (range) {
      case 'COMPOSITE':
        return t('compositeLabel')
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

  // Update sliding indicator position.
  // Use rAF to defer the layout read (offsetLeft/offsetWidth) out of the commit phase.
  // Reading layout geometry synchronously after a state update causes a forced reflow
  // because the browser must finish layout before returning the values.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const activeIndex = TIME_RANGES.indexOf(activeRange)
    if (activeIndex === -1) return
    const raf = requestAnimationFrame(() => {
      const buttons = container.querySelectorAll<HTMLButtonElement>('[data-range-btn]')
      const btn = buttons[activeIndex]
      if (!btn) return
      setIndicatorStyle({
        left: btn.offsetLeft,
        width: btn.offsetWidth,
      })
      hasInitialized.current = true
    })
    return () => cancelAnimationFrame(raf)
  }, [activeRange])

  return (
    <Box
      ref={containerRef}
      className="time-range-selector"
      style={{
        display: 'inline-flex',
        gap: tokens.spacing[0],
        padding: tokens.spacing[1],
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
        position: 'relative',
      }}
    >
      {/* Sliding active indicator */}
      {indicatorStyle && (
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 3,
            bottom: 3,
            left: indicatorStyle.left,
            width: indicatorStyle.width,
            background: `var(--color-accent-primary-12, ${tokens.colors.accent.primary}20)`,
            border: `1px solid var(--color-accent-primary-40, ${tokens.colors.accent.primary}60)`,
            borderRadius: tokens.radius.md,
            boxShadow: '0 1px 3px var(--color-overlay-subtle)',
            transition: hasInitialized.current ? 'left 0.3s cubic-bezier(0.22, 1, 0.36, 1), width 0.3s cubic-bezier(0.22, 1, 0.36, 1)' : 'none',
            pointerEvents: 'none',
            zIndex: 0,
          }}
        />
      )}
      {TIME_RANGES.map((range) => {
        const isActive = activeRange === range
        return (
          <button
            key={range}
            data-range-btn
            onClick={() => !disabled && onChange(range)}
            disabled={disabled}
            className="touch-target"
            style={{
              padding: `10px ${tokens.spacing[4]}`,
              minHeight: 44,
              background: 'transparent',
              color: isActive
                ? tokens.colors.accent.primary
                : tokens.colors.text.tertiary,
              border: '1px solid transparent',
              borderRadius: tokens.radius.md,
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: isActive
                ? tokens.typography.fontWeight.bold
                : tokens.typography.fontWeight.medium,
              cursor: disabled ? 'not-allowed' : 'pointer',
              opacity: disabled ? 0.5 : 1,
              transition: `color ${tokens.duration.normal} ease, font-weight ${tokens.duration.normal} ease`,
              fontFamily: tokens.typography.fontFamily.sans.join(', '),
              lineHeight: 1.2,
              position: 'relative',
              zIndex: 1,
            }}
          >
            {getLabel(range)}
          </button>
        )
      })}
    </Box>
  )
}
