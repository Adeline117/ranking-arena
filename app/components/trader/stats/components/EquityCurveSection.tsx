'use client'

import { useState, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../../../base'
import { useLanguage } from '../../../Providers/LanguageProvider'

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

// Check if ROI data has any meaningful non-zero values
function hasNonZeroRoi(data: Array<{ date: string; roi: number; pnl: number }>): boolean {
  return data.some(d => d.roi !== 0 && d.roi != null)
}

// Determine the best initial chart type based on available data
function getBestChartType(equityCurve: EquityCurveData | undefined): 'roi' | 'pnl' {
  const data = equityCurve?.['90D'] || equityCurve?.['30D'] || equityCurve?.['7D'] || []
  if (!hasNonZeroRoi(data) && data.length > 0) {
    return 'pnl'
  }
  return 'roi'
}

// Auto-select the best period that has data (prefers 90D → 30D → 7D)
function getBestInitialPeriod(equityCurve: EquityCurveData | undefined): '7D' | '30D' | '90D' {
  if (equityCurve?.['90D']?.length) return '90D'
  if (equityCurve?.['30D']?.length) return '30D'
  if (equityCurve?.['7D']?.length) return '7D'
  return '90D'
}

export function EquityCurveSection({
  equityCurve,
  traderHandle: _traderHandle,
  delay
}: EquityCurveSectionProps) {
  const { t, language } = useLanguage()
  const [period, setPeriod] = useState<'7D' | '30D' | '90D'>(() => getBestInitialPeriod(equityCurve))
  const [chartType, setChartType] = useState<'roi' | 'pnl'>(() => getBestChartType(equityCurve))
  const [mounted, setMounted] = useState(false)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

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

  // 所有周期都没有数据时，隐藏整个section
  const allPeriodsEmpty = !equityCurve || (
    (!equityCurve['90D'] || equityCurve['90D'].length === 0) &&
    (!equityCurve['30D'] || equityCurve['30D'].length === 0) &&
    (!equityCurve['7D'] || equityCurve['7D'].length === 0)
  )

  if (allPeriodsEmpty) {
    return (
      <Box
        className="stats-card glass-card"
        style={{
          background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
          borderRadius: tokens.radius.xl,
          border: `1px solid ${tokens.colors.border.primary}60`,
          padding: tokens.spacing[6],
          boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
          opacity: mounted ? 1 : 0,
          transform: mounted ? 'translateY(0)' : 'translateY(20px)',
          transition: prefersReducedMotion ? 'none' : 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
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
          {t('chartDataAccumulatesDaily') || (language === 'zh'
            ? '数据每天积累。首次交易后24小时内即可看到资金曲线图。'
            : 'Data accumulates daily. Check back soon — your first chart will appear within 24 hours of first trade.')}
        </Text>
      </Box>
    )
  }

  return (
    <Box
      className="stats-card glass-card"
      style={{
        background: `linear-gradient(145deg, ${tokens.colors.bg.secondary}F8 0%, ${tokens.colors.bg.primary}F0 100%)`,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}60`,
        padding: tokens.spacing[6],
        boxShadow: `0 4px 24px var(--color-overlay-subtle)`,
        opacity: mounted ? 1 : 0,
        transform: mounted ? 'translateY(0)' : 'translateY(20px)',
        transition: prefersReducedMotion ? 'none' : 'all 0.5s cubic-bezier(0.4, 0, 0.2, 1)',
      }}
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

        {/* Period Selector */}
        <PeriodSelector value={period} onChange={setPeriod} t={t} />
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
            {language === 'zh' ? '数据积累中' : 'Accumulating data...'}
          </Text>
          <Text size="sm" color="tertiary" style={{ textAlign: 'center', maxWidth: 300, lineHeight: 1.6 }}>
            {t('insufficientDataForChart') || (language === 'zh'
              ? `数据点不足（仅 ${currentData.length} 个），图表需要更多数据才能有效展示趋势。`
              : `Not enough data points (only ${currentData.length}). More data is needed to display a meaningful chart.`)}
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
    </Box>
  )
}

// Period Selector Component
function PeriodSelector({
  value,
  onChange,
  t: _t
}: {
  value: '7D' | '30D' | '90D'
  onChange: (v: '7D' | '30D' | '90D') => void
  t: (key: string) => string
}) {
  return (
    <Box
      style={{
        display: 'flex',
        gap: 4,
        background: tokens.colors.bg.tertiary,
        padding: 3,
        borderRadius: tokens.radius.lg,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}
    >
      {(['7D', '30D', '90D'] as const).map((p) => (
        <button
          key={p}
          onClick={() => onChange(p)}
          style={{
            padding: `6px 14px`,
            minHeight: 36,
            borderRadius: tokens.radius.md,
            border: 'none',
            background: value === p ? tokens.colors.bg.primary : 'transparent',
            color: value === p ? tokens.colors.text.primary : tokens.colors.text.secondary,
            fontSize: 13,
            fontWeight: value === p ? 600 : 400,
            cursor: 'pointer',
            transition: 'all 0.2s ease',
            fontFamily: tokens.typography.fontFamily.sans.join(', '),
            boxShadow: value === p ? '0 2px 8px var(--color-overlay-subtle)' : 'none',
          }}
        >
          {p}
        </button>
      ))}
    </Box>
  )
}

// Simple Line Chart with tooltip
function SimpleLineChart({
  data,
  dataKey,
  period,
}: {
  data: Array<{ date: string; roi: number; pnl: number }>
  dataKey: 'roi' | 'pnl'
  period: string
}) {
  const { language } = useLanguage()
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)

  const formatAxisLabel = (val: number) => {
    const abs = Math.abs(val)
    const sign = val < 0 ? '-' : ''
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`
    return `${sign}$${abs.toFixed(0)}`
  }

  if (data.length === 0) {
    return null
  }

  const values = data.map(d => d[dataKey])
  const maxValue = Math.max(...values)
  const minValue = Math.min(...values)
  const range = maxValue - minValue || 1

  const width = 100
  const height = 100
  const denominator = data.length > 1 ? data.length - 1 : 1
  const points = data.map((d, i) => {
    const x = (i / denominator) * width
    const y = height - ((d[dataKey] - minValue) / range) * height
    return `${x},${y}`
  })
  const pathD = `M ${points.join(' L ')}`

  const isPositive = values[values.length - 1] >= values[0]
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  const locale = language === 'zh' ? 'zh-CN' : 'en-US'

  const formatTooltipValue = (val: number) => {
    if (dataKey === 'roi') return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`
    const abs = Math.abs(val)
    const sign = val >= 0 ? '+' : '-'
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
    return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!chartRef.current || data.length === 0) return
    const rect = chartRef.current.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const pct = relX / rect.width
    const idx = Math.round(pct * (data.length - 1))
    const clampedIdx = Math.max(0, Math.min(data.length - 1, idx))
    setHoverIndex(clampedIdx)
    setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const handleMouseLeave = () => {
    setHoverIndex(null)
    setTooltipPos(null)
  }

  const hoverData = hoverIndex !== null ? data[hoverIndex] : null

  return (
    <Box style={{
      height: '100%',
      background: `linear-gradient(180deg, ${tokens.colors.bg.primary} 0%, ${tokens.colors.bg.secondary}40 100%)`,
      borderRadius: tokens.radius.xl,
      padding: tokens.spacing[4],
      position: 'relative',
      border: `1px solid ${tokens.colors.border.primary}40`,
    }}>
      {/* Y-axis Labels */}
      <Box style={{
        position: 'absolute',
        left: tokens.spacing[3],
        top: tokens.spacing[4],
        bottom: tokens.spacing[8],
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
      }}>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), fontSize: 11 }}>
          {dataKey === 'roi' ? `${maxValue.toFixed(0)}%` : formatAxisLabel(maxValue)}
        </Text>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), fontSize: 11 }}>
          {dataKey === 'roi' ? `${minValue.toFixed(0)}%` : formatAxisLabel(minValue)}
        </Text>
      </Box>

      {/* Chart Area */}
      <Box
        ref={chartRef}
        style={{
          marginLeft: 55,
          height: 'calc(100% - 32px)',
          position: 'relative',
          cursor: 'crosshair',
        }}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%' }}
        >
          {/* Grid */}
          {[0, 25, 50, 75, 100].map(y => (
            <line key={y} x1="0" y1={y} x2="100" y2={y} stroke={tokens.colors.border.primary} strokeWidth="0.3" strokeDasharray="2,2" />
          ))}

          {/* Area Fill */}
          <path
            d={`${pathD} L 100,100 L 0,100 Z`}
            fill={`url(#gradient-${period}-${isPositive ? 'positive' : 'negative'})`}
            opacity="0.4"
          />

          {/* Line - thicker stroke */}
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="3"
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Hover vertical line */}
          {hoverIndex !== null && (
            <line
              x1={(hoverIndex / denominator) * width}
              y1="0"
              x2={(hoverIndex / denominator) * width}
              y2="100"
              stroke={tokens.colors.text.tertiary}
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="3,3"
            />
          )}

          {/* Hover dot */}
          {hoverIndex !== null && (() => {
            const cx = (hoverIndex / denominator) * width
            const cy = height - ((data[hoverIndex][dataKey] - minValue) / range) * height
            return <circle cx={cx} cy={cy} r="4" fill={color} stroke={tokens.colors.bg.primary} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          })()}

          {/* Gradient Definitions */}
          <defs>
            <linearGradient id={`gradient-${period}-positive`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.success} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.success} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`gradient-${period}-negative`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.error} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.error} stopOpacity="0" />
            </linearGradient>
          </defs>
        </svg>

        {/* Tooltip */}
        {hoverData && tooltipPos && (
          <Box
            style={{
              position: 'absolute',
              left: tooltipPos.x,
              top: tooltipPos.y - 60,
              transform: 'translateX(-50%)',
              background: tokens.colors.bg.primary,
              border: `1px solid ${tokens.colors.border.primary}`,
              borderRadius: tokens.radius.lg,
              padding: `${tokens.spacing[2]} ${tokens.spacing[3]}`,
              boxShadow: '0 4px 16px var(--color-overlay-medium)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
              zIndex: 10,
            }}
          >
            <Text size="xs" color="tertiary" style={{ marginBottom: 2, display: 'block' }}>
              {new Date(hoverData.date).toLocaleDateString(locale, { month: 'short', day: 'numeric' })}
            </Text>
            <Text size="sm" weight="bold" style={{ color, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
              {formatTooltipValue(hoverData[dataKey])}
            </Text>
            {dataKey === 'roi' && hoverData.pnl !== undefined && (
              <Text size="xs" color="tertiary" style={{ display: 'block', marginTop: 2, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                PnL: {formatTooltipValue(hoverData.pnl).replace(/[+-]/, m => m)}
              </Text>
            )}
            {dataKey === 'pnl' && hoverData.roi !== undefined && (
              <Text size="xs" color="tertiary" style={{ display: 'block', marginTop: 2, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                ROI: {hoverData.roi >= 0 ? '+' : ''}{hoverData.roi.toFixed(2)}%
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* X-axis Labels */}
      <Box style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginLeft: 55,
        marginTop: tokens.spacing[2],
      }}>
        <Text size="xs" color="tertiary" style={{ fontSize: 11 }}>
          {data[0]?.date ? new Date(data[0].date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
        {data.length > 4 && (
          <Text size="xs" color="tertiary" style={{ fontSize: 11 }}>
            {new Date(data[Math.floor(data.length / 2)].date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })}
          </Text>
        )}
        <Text size="xs" color="tertiary" style={{ fontSize: 11 }}>
          {data[data.length - 1]?.date ? new Date(data[data.length - 1].date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
      </Box>
    </Box>
  )
}
