'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'
import { usePeriodStore } from '@/lib/stores/periodStore'

export type Period = '7D' | '30D' | '90D'

// Data source period mapping notes
// Platforms that return cumulative (all-time) ROI instead of period-specific
export const CUMULATIVE_ROI_PLATFORMS = new Set([
  'binance_futures', 'binance_spot', 'bybit', 'bitget_futures',
  'dydx', 'gmx', 'btcc',
])

export const DATA_SOURCE_NOTES: Record<string, { titleKey: string; periods: Record<string, string> }> = {
  weex: {
    titleKey: 'weexDataNote',
    periods: {
      '7D': '--',
      '30D': 'weexPeriod30d',
      '90D': 'weexPeriod90d',
    },
  },
}

export interface PeriodSelectorProps {
  period: Period
  onPeriodChange: (period: Period) => void
  source?: string
  lastUpdated?: string
}

export function PeriodSelector({ period, onPeriodChange, source, lastUpdated }: PeriodSelectorProps) {
  const { t, language } = useLanguage()
  const setGlobalPeriod = usePeriodStore(s => s.setPeriod)
  const containerRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number } | null>(null)

  // Sliding indicator: measure active button position.
  // Use rAF to defer the layout read (offsetLeft/offsetWidth) out of the commit phase.
  // Reading layout geometry synchronously after a state update causes a forced reflow.
  const updateIndicator = useCallback(() => {
    if (!containerRef.current) return
    const periods: Period[] = ['7D', '30D', '90D']
    const idx = periods.indexOf(period)
    const buttons = containerRef.current.querySelectorAll<HTMLButtonElement>('button')
    const btn = buttons[idx]
    if (btn) {
      setIndicatorStyle({
        left: btn.offsetLeft,
        width: btn.offsetWidth,
      })
    }
  }, [period])

  useEffect(() => {
    const raf = requestAnimationFrame(updateIndicator)
    return () => cancelAnimationFrame(raf)
  }, [updateIndicator])

  // Sync selected period to global store so ShareOnXButton reads the current window
  useEffect(() => {
    setGlobalPeriod(period)
  }, [period, setGlobalPeriod])

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: tokens.spacing[5],
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {t('performance')}
        </Text>
        {lastUpdated && (
          <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
            {t('updatedAt')} {new Date(lastUpdated).toLocaleTimeString(getLocaleFromLanguage(language), { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </Box>

      {/* Period Selector */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        {/* Cumulative ROI note for platforms that don't support period-specific ROI */}
        {source && CUMULATIVE_ROI_PLATFORMS.has(source.toLowerCase()) && period !== '7D' && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: '4px 8px',
              background: 'color-mix(in srgb, var(--color-text-tertiary) 8%, transparent)',
              borderRadius: tokens.radius.md,
            }}
            title={t('cumulativeRoiTooltip')}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--color-text-tertiary)" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
              {t('cumulativeRoiLabel')}
            </Text>
          </Box>
        )}

        {/* 数据来源提示 */}
        {source && DATA_SOURCE_NOTES[source.toLowerCase()] && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: '4px 8px',
              background: tokens.colors.accent.warning + '15',
              borderRadius: tokens.radius.md,
              border: '1px solid ' + tokens.colors.accent.warning + '30',
            }}
            title={(() => {
              const note = DATA_SOURCE_NOTES[source.toLowerCase()]
              const p30 = note.periods['30D'] === '--' ? '--' : t(note.periods['30D'])
              const p90 = note.periods['90D'] === '--' ? '--' : t(note.periods['90D'])
              return t(note.titleKey) + ': 30D=' + p30 + ', 90D=' + p90
            })()}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={tokens.colors.accent.warning} strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <Text size="xs" style={{ color: tokens.colors.accent.warning, fontWeight: 500 }}>
              {(() => {
                const pKey = DATA_SOURCE_NOTES[source.toLowerCase()].periods[period]
                return pKey ? (pKey === '--' ? '--' : t(pKey)) : period
              })()}
            </Text>
          </Box>
        )}

        <Box
          ref={containerRef}
          style={{
            display: 'flex',
            gap: tokens.spacing[1],
            background: tokens.colors.bg.tertiary,
            padding: tokens.spacing[1],
            borderRadius: tokens.radius.lg,
            border: '1px solid ' + tokens.colors.border.primary,
            position: 'relative',
          }}
        >
          {/* Sliding indicator pill */}
          {indicatorStyle && (
            <div
              style={{
                position: 'absolute',
                top: tokens.spacing[1],
                left: indicatorStyle.left,
                width: indicatorStyle.width,
                height: `calc(100% - ${tokens.spacing[1]} - ${tokens.spacing[1]})`,
                borderRadius: tokens.radius.md,
                background: tokens.colors.bg.primary,
                boxShadow: '0 2px 8px var(--color-overlay-subtle)',
                transition: 'left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                pointerEvents: 'none',
                zIndex: 0,
              }}
            />
          )}
          {(['7D', '30D', '90D'] as Period[]).map((p) => {
            const sourceNote = source && DATA_SOURCE_NOTES[source.toLowerCase()]
            const isDisabled = !!(sourceNote && sourceNote.periods[p] === '--')
            const label = p === '7D' ? '7D' : p === '30D' ? '30D' : '90D'
            return (
              <button
                key={p}
                onClick={() => { if (!isDisabled) onPeriodChange(p) }}
                disabled={isDisabled}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  minHeight: 44,
                  borderRadius: tokens.radius.md,
                  border: 'none',
                  background: 'transparent',
                  color: isDisabled
                    ? tokens.colors.text.tertiary
                    : period === p
                      ? tokens.colors.text.primary
                      : tokens.colors.text.secondary,
                  fontSize: 13,
                  fontWeight: period === p ? 600 : 400,
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  transition: 'color 0.2s ease, font-weight 0.2s ease',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  opacity: isDisabled ? 0.5 : 1,
                  position: 'relative',
                  zIndex: 1,
                }}
                title={isDisabled ? t('noDataForPeriod') : undefined}
              >
                {label}
              </button>
            )
          })}
        </Box>
      </Box>
    </Box>
  )
}
