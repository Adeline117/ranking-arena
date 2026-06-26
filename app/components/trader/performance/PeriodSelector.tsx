'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens, alpha } from '@/lib/design-tokens'
import { Box, Text } from '../../base'
import { useLanguage } from '../../Providers/LanguageProvider'

export type Period = '7D' | '30D' | '90D'

// Data source period mapping notes
// Platforms that return cumulative (all-time) ROI instead of period-specific
export const CUMULATIVE_ROI_PLATFORMS = new Set([
  'binance_futures',
  'binance_spot',
  'bybit',
  'bitget_futures',
  'dydx',
  'gmx',
  'btcc',
])

// Platforms where 90D data actually uses allTime window (API doesn't support 90D natively)
export const ALLTIME_90D_PLATFORMS = new Set(['hyperliquid_perp'])

// Platforms where ROI is derived from PnL/Equity rather than native ROI API
export const DERIVED_ROI_PLATFORMS = new Set(['dydx'])

export const DATA_SOURCE_NOTES: Record<
  string,
  { titleKey: string; periods: Record<string, string> }
> = {
  weex: {
    titleKey: 'weexDataNote',
    periods: {
      '7D': '--',
      '30D': 'weexPeriod30d',
      '90D': 'weexPeriod90d',
    },
  },
}

/** Serving-mode TF availability (spec §6): native | derived | absent. */
export type PeriodAvailability = Partial<Record<Period, 'native' | 'derived' | 'absent'>>

export interface PeriodSelectorProps {
  period: Period
  onPeriodChange: (period: Period) => void
  source?: string
  lastUpdated?: string
  /** Capability-driven availability — 'absent' disables the tab with a
   *  "Not provided by this exchange" tooltip, 'derived' shows the
   *  derived-board chip (spec §6). Legacy callers omit this. */
  availability?: PeriodAvailability
  /** Bots expose a 4th "since inception" timeframe (spec §1.1-B). */
  showInception?: boolean
  inceptionSelected?: boolean
  onInceptionSelect?: () => void
}

export function PeriodSelector({
  period,
  onPeriodChange,
  source,
  lastUpdated,
  availability,
  showInception,
  inceptionSelected,
  onInceptionSelect,
}: PeriodSelectorProps) {
  const { t, language } = useLanguage()
  const containerRef = useRef<HTMLDivElement>(null)
  const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number } | null>(null)

  // Sliding indicator: measure active button position.
  // Use rAF to defer the layout read (offsetLeft/offsetWidth) out of the commit phase.
  // Reading layout geometry synchronously after a state update causes a forced reflow.
  const updateIndicator = useCallback(() => {
    if (!containerRef.current) return
    const periods: Period[] = ['7D', '30D', '90D']
    const idx = showInception && inceptionSelected ? periods.length : periods.indexOf(period)
    const buttons = containerRef.current.querySelectorAll<HTMLButtonElement>('button')
    const btn = buttons[idx]
    if (btn) {
      setIndicatorStyle({
        left: btn.offsetLeft,
        width: btn.offsetWidth,
      })
    }
  }, [period, showInception, inceptionSelected])

  useEffect(() => {
    const raf = requestAnimationFrame(updateIndicator)
    return () => cancelAnimationFrame(raf)
  }, [updateIndicator])

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        // Wrap on narrow viewports: at 375px the title + derived-timeframe badge +
        // 7D/30D/90D toggle overflow this row, and the toggle's overflow:hidden
        // parent silently clipped 90D off the right edge — making the core-path
        // period switch unreachable on mobile. Wrapping drops the selector to its
        // own full-width row so every period stays tappable.
        flexWrap: 'wrap',
        gap: tokens.spacing[2],
        marginBottom: tokens.spacing[5],
      }}
    >
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[3] }}>
        <Text size="lg" weight="black" style={{ color: tokens.colors.text.primary }}>
          {t('performance')}
        </Text>
        {lastUpdated && (
          <Text size="xs" color="tertiary" style={{ opacity: 0.6 }}>
            {t('updatedAt')}{' '}
            {new Date(lastUpdated).toLocaleTimeString(getLocaleFromLanguage(language), {
              hour: '2-digit',
              minute: '2-digit',
              timeZoneName: 'short',
            })}
          </Text>
        )}
      </Box>

      {/* Period Selector */}
      <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
        {/* Serving-mode derived timeframe disclosure (spec §6) */}
        {availability?.[period] === 'derived' && !inceptionSelected && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: '4px 8px',
              background: 'color-mix(in srgb, var(--color-text-tertiary) 8%, transparent)',
              borderRadius: tokens.radius.md,
            }}
            title={t('derivedBoardTooltip')}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-text-tertiary)"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
              {t('derivedBoardBadge')}
            </Text>
          </Box>
        )}

        {/* Hyperliquid 90D = allTime disclosure */}
        {source && ALLTIME_90D_PLATFORMS.has(source.toLowerCase()) && period === '90D' && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: '4px 8px',
              background: 'color-mix(in srgb, var(--color-text-tertiary) 8%, transparent)',
              borderRadius: tokens.radius.md,
            }}
            title={t('allTime90dTooltip')}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-text-tertiary)"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
              {t('allTime90dLabel')}
            </Text>
          </Box>
        )}

        {/* dYdX derived ROI disclosure */}
        {source && DERIVED_ROI_PLATFORMS.has(source.toLowerCase()) && (
          <Box
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[1],
              padding: '4px 8px',
              background: 'color-mix(in srgb, var(--color-text-tertiary) 8%, transparent)',
              borderRadius: tokens.radius.md,
            }}
            title={t('derivedRoiTooltip')}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-text-tertiary)"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="16" x2="12" y2="12" />
              <line x1="12" y1="8" x2="12.01" y2="8" />
            </svg>
            <Text size="xs" style={{ color: 'var(--color-text-tertiary)', fontWeight: 500 }}>
              {t('derivedRoiLabel')}
            </Text>
          </Box>
        )}

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
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="var(--color-text-tertiary)"
              strokeWidth="2"
            >
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
              background: alpha(tokens.colors.accent.warning, 8),
              borderRadius: tokens.radius.md,
              border: '1px solid ' + alpha(tokens.colors.accent.warning, 19),
            }}
            title={(() => {
              const note = DATA_SOURCE_NOTES[source.toLowerCase()]
              const p30 = note.periods['30D'] === '--' ? '--' : t(note.periods['30D'])
              const p90 = note.periods['90D'] === '--' ? '--' : t(note.periods['90D'])
              return t(note.titleKey) + ': 30D=' + p30 + ', 90D=' + p90
            })()}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke={tokens.colors.accent.warning}
              strokeWidth="2"
            >
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
                transition:
                  'left 0.25s cubic-bezier(0.4, 0, 0.2, 1), width 0.25s cubic-bezier(0.4, 0, 0.2, 1)',
                pointerEvents: 'none',
                zIndex: 0,
              }}
            />
          )}
          {(['7D', '30D', '90D'] as Period[]).map((p) => {
            const sourceNote = source && DATA_SOURCE_NOTES[source.toLowerCase()]
            const isAbsent = availability?.[p] === 'absent'
            const isDisabled = !!(sourceNote && sourceNote.periods[p] === '--') || isAbsent
            const isActive = period === p && !inceptionSelected
            const label = p === '7D' ? '7D' : p === '30D' ? '30D' : '90D'
            return (
              <button
                key={p}
                onClick={() => {
                  if (!isDisabled) onPeriodChange(p)
                }}
                disabled={isDisabled}
                aria-pressed={isActive}
                aria-label={`${label} period`}
                style={{
                  padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                  minHeight: 44,
                  borderRadius: tokens.radius.md,
                  border: 'none',
                  background: 'transparent',
                  color: isDisabled
                    ? tokens.colors.text.tertiary
                    : isActive
                      ? tokens.colors.text.primary
                      : tokens.colors.text.secondary,
                  fontSize: 13,
                  fontWeight: isActive ? 600 : 400,
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  transition: 'all 0.2s ease',
                  fontFamily: tokens.typography.fontFamily.sans.join(', '),
                  opacity: isDisabled ? 0.5 : 1,
                  position: 'relative',
                  zIndex: 1,
                }}
                onMouseEnter={(e) => {
                  if (!isDisabled && !isActive)
                    e.currentTarget.style.background =
                      'var(--color-bg-tertiary, rgba(255,255,255,0.05))'
                }}
                onMouseLeave={(e) => {
                  if (!isDisabled && !isActive) e.currentTarget.style.background = 'transparent'
                }}
                title={
                  isDisabled ? (isAbsent ? t('tfNotProvided') : t('noDataForPeriod')) : undefined
                }
                aria-disabled={isDisabled || undefined}
              >
                {label}
              </button>
            )
          })}
          {/* Bots: 4th "since inception" tab (spec §1.1-B; never ranked on) */}
          {showInception && onInceptionSelect && (
            <button
              onClick={onInceptionSelect}
              aria-pressed={Boolean(inceptionSelected)}
              aria-label={`${t('tfInception')} period`}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                minHeight: 44,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: 'transparent',
                color: inceptionSelected
                  ? tokens.colors.text.primary
                  : tokens.colors.text.secondary,
                fontSize: 13,
                fontWeight: inceptionSelected ? 600 : 400,
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
                position: 'relative',
                zIndex: 1,
              }}
              onMouseEnter={(e) => {
                if (!inceptionSelected)
                  e.currentTarget.style.background =
                    'var(--color-bg-tertiary, rgba(255,255,255,0.05))'
              }}
              onMouseLeave={(e) => {
                if (!inceptionSelected) e.currentTarget.style.background = 'transparent'
              }}
            >
              {t('tfInception')}
            </button>
          )}
        </Box>

        {/* Always-visible note when selected period has no data for this platform */}
        {source &&
          (() => {
            const sourceNote = DATA_SOURCE_NOTES[source.toLowerCase()]
            if (sourceNote && sourceNote.periods[period] === '--') {
              return (
                <Text size="xs" style={{ color: tokens.colors.accent.warning, fontWeight: 500 }}>
                  {t('noDataForPeriod')}
                </Text>
              )
            }
            return null
          })()}
      </Box>
    </Box>
  )
}
