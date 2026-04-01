'use client'

import { useState, useEffect } from 'react'
import dynamic from 'next/dynamic'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { PeriodSelector, getBestChartType, getBestInitialPeriod, hasNonZeroRoi } from './ChartControls'
import { SimpleLineChart } from './SimpleLineChart'

const ChartFullscreen = dynamic(() => import('../../../ui/ChartFullscreen'), { ssr: false })

interface EquityCurveData {
  '90D': Array<{ date: string; roi: number; pnl: number }>
  '30D': Array<{ date: string; roi: number; pnl: number }>
  '7D': Array<{ date: string; roi: number; pnl: number }>
}

interface EquityCurveSectionProps {
  equityCurve?: EquityCurveData
  traderHandle: string
  delay: number
}

export function EquityCurveSection({
  equityCurve,
  traderHandle: _traderHandle,
  delay
}: EquityCurveSectionProps) {
  const { t } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>(() => getBestInitialPeriod(equityCurve))
  const [chartType, setChartType] = useState<'roi' | 'pnl'>(() => getBestChartType(equityCurve))
  const [mounted, setMounted] = useState(false)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)
  const [showFullscreen, setShowFullscreen] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    setPrefersReducedMotion(mq.matches)
    const handler = (e: MediaQueryListEvent) => setPrefersReducedMotion(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])

  useEffect(() => {
    if (prefersReducedMotion) {
      setMounted(true)
      return
    }
    const timer = setTimeout(() => setMounted(true), delay * 1000)
    return () => clearTimeout(timer)
  }, [delay, prefersReducedMotion])

  // Auto-switch chart type when the selected period has no data for current type
  useEffect(() => {
    const periodData = equityCurve?.[period] || []
    if (periodData.length === 0) return
    if (chartType === 'roi' && !hasNonZeroRoi(periodData)) {
      setChartType('pnl')
    }
  }, [period, equityCurve, chartType])

  const currentData = equityCurve?.[period] || []
  const hasData = currentData.length > 0

  // Hide entire section when all periods are empty
  const allPeriodsEmpty = !equityCurve || (
    (!equityCurve['90D'] || equityCurve['90D'].length === 0) &&
    (!equityCurve['30D'] || equityCurve['30D'].length === 0) &&
    (!equityCurve['7D'] || equityCurve['7D'].length === 0)
  )

  const cardStyle = {
    background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
    borderRadius: tokens.radius.xl,
    border: `1px solid ${tokens.colors.border.primary}60`,
    padding: tokens.spacing[6],
    boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
    opacity: mounted ? 1 : 0,
    transform: mounted ? 'translateY(0)' : 'translateY(20px)',
    transition: prefersReducedMotion ? 'none' : 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
  }

  if (allPeriodsEmpty) {
    return (
      <Box
        className="stats-card glass-card"
        style={{
          ...cardStyle,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: 200,
          gap: tokens.spacing[3],
        }}
      >
        {/* CSS-art chart outline illustration */}
        <svg width="56" height="44" viewBox="0 0 56 44" fill="none" style={{ opacity: 0.25, color: 'var(--color-text-tertiary)' }}>
          <path d="M4 40V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M4 40h48" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <path d="M4 32l10-8 8 4 10-12 10 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="3 3" />
          <circle cx="4" cy="32" r="2" fill="currentColor" />
          <circle cx="14" cy="24" r="2" fill="currentColor" opacity="0.5" />
          <circle cx="22" cy="28" r="2" fill="currentColor" opacity="0.5" />
          <circle cx="32" cy="16" r="2" fill="currentColor" opacity="0.5" />
          <circle cx="42" cy="22" r="2" fill="currentColor" opacity="0.5" />
        </svg>
        <Text size="sm" weight="semibold" color="tertiary" style={{ textAlign: 'center' }}>
          {t('noEquityCurveData')}
        </Text>
        <Text size="xs" color="tertiary" style={{ textAlign: 'center', maxWidth: 280, lineHeight: 1.6, opacity: 0.8 }}>
          {t('chartDataAccumulatesDaily')}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      className="stats-card glass-card"
      style={cardStyle}
    >
      <Box style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing[4] }}>
        {/* Chart Type Toggle */}
        <Box
          style={{
            display: 'flex',
            gap: 2,
            background: tokens.colors.bg.tertiary,
            padding: 3,
            borderRadius: tokens.radius.lg,
          }}
        >
          {(['roi', 'pnl'] as const).map((type) => (
            <button
              key={type}
              onClick={() => setChartType(type)}
              style={{
                padding: `${tokens.spacing[2]} ${tokens.spacing[4]}`,
                borderRadius: tokens.radius.md,
                border: 'none',
                background: chartType === type
                  ? `linear-gradient(135deg, ${tokens.colors.accent.primary}, ${tokens.colors.accent.brand})`
                  : 'transparent',
                color: chartType === type ? 'var(--color-on-accent)' : tokens.colors.text.tertiary,
                fontSize: tokens.typography.fontSize.sm,
                fontWeight: tokens.typography.fontWeight.bold,
                cursor: 'pointer',
                transition: 'all 0.25s ease',
                fontFamily: tokens.typography.fontFamily.sans.join(', '),
              }}
            >
              {type === 'roi' ? t('roi') : t('pnl')}
            </button>
          ))}
        </Box>

        <Box style={{ display: 'flex', alignItems: 'center', gap: tokens.spacing[2] }}>
          {/* Period Selector */}
          <PeriodSelector value={period} onChange={setPeriod} t={t} />
          {/* Export chart as image */}
          <button
            onClick={async () => {
              const chartContainer = document.querySelector('.chart-container')
              if (!chartContainer) return
              try {
                const { default: html2canvas } = await import(/* webpackIgnore: true */ 'html2canvas' as string) as { default: (el: HTMLElement, opts?: Record<string, unknown>) => Promise<HTMLCanvasElement> }
                const canvas = await html2canvas(chartContainer as HTMLElement, { backgroundColor: null })
                const link = document.createElement('a')
                link.download = `arena-chart-${period}-${chartType}.png`
                link.href = canvas.toDataURL('image/png')
                link.click()
              } catch {
                // Fallback: export SVG directly
                const svg = chartContainer.querySelector('svg')
                if (svg) {
                  const blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' })
                  const link = document.createElement('a')
                  link.download = `arena-chart-${period}-${chartType}.svg`
                  link.href = URL.createObjectURL(blob)
                  link.click()
                  URL.revokeObjectURL(link.href)
                }
              }
            }}
            aria-label={t('exportChart') || 'Export chart'}
            style={{
              background: 'none',
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.sm,
              padding: tokens.spacing[1],
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" strokeLinecap="round" strokeLinejoin="round" />
              <polyline points="7 10 12 15 17 10" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="12" y1="15" x2="12" y2="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {/* Fullscreen button */}
          <button
            onClick={() => setShowFullscreen(true)}
            aria-label={t('traderFullscreen')}
            style={{
              background: 'none',
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.sm,
              padding: tokens.spacing[1],
              color: tokens.colors.text.secondary,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
              <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </Box>
      </Box>

      {hasData && currentData.length <= 3 ? (
        <Box style={{
          height: 280,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: tokens.spacing[3],
          background: `${tokens.colors.bg.tertiary}40`,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
        }}>
          {/* Hourglass / accumulating data illustration */}
          <svg width="40" height="40" viewBox="0 0 40 40" fill="none" style={{ opacity: 0.3, color: 'var(--color-text-tertiary)' }}>
            <path d="M10 6h20M10 34h20M12 6c0 8 8 12 8 14S12 26 12 34M28 6c0 8-8 12-8 14s8 6 8 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="20" cy="20" r="2" fill="currentColor" opacity="0.5" />
          </svg>
          <Text size="sm" weight="semibold" color="tertiary" style={{ textAlign: 'center' }}>
            {t('traderAccumulatingData')}
          </Text>
          <Text size="sm" color="tertiary" style={{ textAlign: 'center', maxWidth: 300, lineHeight: 1.6 }}>
            {t('insufficientDataForChart')}
          </Text>
          <Text size="xs" color="tertiary" style={{ textAlign: 'center', fontFamily: tokens.typography.fontFamily.mono.join(', '), opacity: 0.7 }}>
            {currentData.map(d => `${new Date(d.date).toLocaleDateString()}: ${chartType === 'roi' ? d.roi.toFixed(2) + '%' : '$' + d.pnl.toLocaleString()}`).join('  |  ')}
          </Text>
        </Box>
      ) : hasData ? (
        <Box className="chart-container" style={{ height: 280 }}>
          <SimpleLineChart
            data={currentData}
            dataKey={chartType}
            period={period}
          />
        </Box>
      ) : (
        <Box style={{
          height: 280,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `${tokens.colors.bg.tertiary}40`,
          borderRadius: tokens.radius.xl,
        }}>
          <Text size="sm" color="tertiary">
            {t('noDataForPeriod')}
          </Text>
        </Box>
      )}

      {/* Fullscreen chart overlay */}
      <ChartFullscreen
        open={showFullscreen}
        onClose={() => setShowFullscreen(false)}
        title={chartType === 'roi' ? t('roi') : t('pnl')}
      >
        {hasData && currentData.length > 3 ? (
          <SimpleLineChart data={currentData} dataKey={chartType} period={period} />
        ) : (
          <Box style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Text size="sm" color="tertiary">{t('noDataForPeriod')}</Text>
          </Box>
        )}
      </ChartFullscreen>
    </Box>
  )
}
