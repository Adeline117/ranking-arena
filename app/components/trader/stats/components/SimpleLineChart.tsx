'use client'

import { useState, useEffect, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

/**
 * Fill date gaps in time-series data with linearly interpolated values.
 * Prevents misleading visual jumps when days are missing.
 */
function fillDateGaps(data: Array<{ date: string; roi: number; pnl: number }>): Array<{ date: string; roi: number; pnl: number }> {
  if (data.length < 2) return data
  const filled: Array<{ date: string; roi: number; pnl: number }> = []
  for (let i = 0; i < data.length; i++) {
    filled.push(data[i])
    if (i < data.length - 1) {
      const current = new Date(data[i].date)
      const next = new Date(data[i + 1].date)
      const gap = Math.round((next.getTime() - current.getTime()) / 86400000)
      if (gap > 1) {
        const startRoi = data[i].roi
        const endRoi = data[i + 1].roi
        const startPnl = data[i].pnl
        const endPnl = data[i + 1].pnl
        for (let d = 1; d < gap; d++) {
          const t = d / gap
          const fillDate = new Date(current.getTime() + d * 86400000)
          filled.push({
            date: fillDate.toISOString().split('T')[0],
            roi: startRoi + (endRoi - startRoi) * t,
            pnl: startPnl + (endPnl - startPnl) * t,
          })
        }
      }
    }
  }
  return filled
}

interface SimpleLineChartProps {
  data: Array<{ date: string; roi: number; pnl: number }>
  dataKey: 'roi' | 'pnl'
  period: string
}

export function SimpleLineChart({
  data,
  dataKey,
  period,
}: SimpleLineChartProps) {
  const { language } = useLanguage()
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null)
  const chartRef = useRef<HTMLDivElement>(null)
  // Zoom state: show a subset of data points
  const [zoomLevel, setZoomLevel] = useState(1) // 1 = full data, 2 = half, 4 = quarter
  const [zoomOffset, setZoomOffset] = useState(0) // offset from the end

  const formatAxisLabel = (val: number) => {
    const abs = Math.abs(val)
    const sign = val < 0 ? '-' : ''
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`
    if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`
    return `${sign}$${abs.toFixed(0)}`
  }

  // Reset zoom when data/period changes
  useEffect(() => { setZoomLevel(1); setZoomOffset(0) }, [data, period])

  if (data.length === 0) {
    return null
  }

  // Fill date gaps with zero entries to prevent misleading visual jumps
  const gapFilled = fillDateGaps(data)
  // Filter out data points with null/NaN values defensively (API types say number, but runtime may differ)
  const allValidData = gapFilled.filter(d => d[dataKey] != null && !isNaN(d[dataKey] as number))
  if (allValidData.length === 0) return null

  // Apply zoom: show a window of data points
  const windowSize = Math.max(4, Math.ceil(allValidData.length / zoomLevel))
  const maxOffset = Math.max(0, allValidData.length - windowSize)
  const effectiveOffset = Math.min(zoomOffset, maxOffset)
  const startIdx = Math.max(0, allValidData.length - windowSize - effectiveOffset)
  const endIdx = startIdx + windowSize
  const validData = allValidData.slice(startIdx, endIdx)

  const values = validData.map(d => d[dataKey] as number)
  const maxValue = Math.max(...values)
  const minValue = Math.min(...values)
  // Guard against Infinity/-Infinity
  if (!isFinite(maxValue) || !isFinite(minValue)) return null
  const range = maxValue - minValue || 1

  const width = 100
  const height = 100
  const denominator = validData.length > 1 ? validData.length - 1 : 1
  const points = validData.map((d, i) => {
    const x = (i / denominator) * width
    const y = height - ((d[dataKey] as number - minValue) / range) * height
    return `${x},${y}`
  })
  const pathD = `M ${points.join(' L ')}`

  // Baseline series: baseline is 0 for both ROI and PnL
  const baselineValue = 0
  const baselineY = range === 0 ? height / 2 : height - ((baselineValue - minValue) / range) * height
  const clampedBaselineY = Math.max(0, Math.min(height, baselineY))

  const isPositive = values[values.length - 1] >= values[0]
  const color = isPositive ? tokens.colors.accent.success : tokens.colors.accent.error

  // Check if baseline is within view (mixed positive/negative data)
  const hasBaseline = minValue < 0 && maxValue > 0

  const locale = language === 'zh' ? 'zh-CN' : language === 'ja' ? 'ja-JP' : language === 'ko' ? 'ko-KR' : 'en-US'

  const formatTooltipValue = (val: number) => {
    if (dataKey === 'roi') return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`
    const abs = Math.abs(val)
    const sign = val >= 0 ? '+' : '-'
    if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
    return `${sign}$${abs.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  }

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!chartRef.current || validData.length === 0) return
    const rect = chartRef.current.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const pct = relX / rect.width
    const idx = Math.round(pct * (validData.length - 1))
    const clampedIdx = Math.max(0, Math.min(validData.length - 1, idx))
    setHoverIndex(clampedIdx)
    setTooltipPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }

  const handleMouseLeave = () => {
    setHoverIndex(null)
    setTooltipPos(null)
  }

  const hoverData = hoverIndex !== null ? validData[hoverIndex] : null

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
          {dataKey === 'roi' ? `${maxValue.toFixed(Math.abs(maxValue) < 10 ? 1 : 0)}%` : formatAxisLabel(maxValue)}
        </Text>
        <Text size="xs" color="tertiary" style={{ fontFamily: tokens.typography.fontFamily.mono.join(', '), fontSize: 11 }}>
          {dataKey === 'roi' ? `${minValue.toFixed(Math.abs(minValue) < 10 ? 1 : 0)}%` : formatAxisLabel(minValue)}
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

          {/* Baseline zero line (when data crosses zero) */}
          {hasBaseline && (
            <line
              x1="0" y1={clampedBaselineY} x2="100" y2={clampedBaselineY}
              stroke={tokens.colors.text.tertiary}
              strokeWidth="0.5"
              strokeDasharray="2,2"
              opacity="0.6"
            />
          )}

          {/* Baseline series: split fill above/below zero using clipPath */}
          <defs>
            {/* Clip to above baseline (profit zone) */}
            <clipPath id={`clip-above-${period}`}>
              <rect x="0" y="0" width={width} height={clampedBaselineY} />
            </clipPath>
            {/* Clip to below baseline (loss zone) */}
            <clipPath id={`clip-below-${period}`}>
              <rect x="0" y={clampedBaselineY} width={width} height={height - clampedBaselineY} />
            </clipPath>
            <linearGradient id={`gradient-${period}-positive`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.success} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.success} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`gradient-${period}-negative`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={tokens.colors.accent.error} stopOpacity="0.4" />
              <stop offset="100%" stopColor={tokens.colors.accent.error} stopOpacity="0" />
            </linearGradient>
          </defs>

          {hasBaseline ? (
            <>
              {/* Green area fill above baseline */}
              <path
                d={`${pathD} L ${width},${clampedBaselineY} L 0,${clampedBaselineY} Z`}
                fill={`url(#gradient-${period}-positive)`}
                clipPath={`url(#clip-above-${period})`}
                opacity="0.4"
              />
              {/* Red area fill below baseline */}
              <path
                d={`${pathD} L ${width},${clampedBaselineY} L 0,${clampedBaselineY} Z`}
                fill={`url(#gradient-${period}-negative)`}
                clipPath={`url(#clip-below-${period})`}
                opacity="0.4"
              />
              {/* Green line above baseline */}
              <path
                d={pathD}
                fill="none"
                stroke={tokens.colors.accent.success}
                strokeWidth="3"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
                clipPath={`url(#clip-above-${period})`}
              />
              {/* Red line below baseline */}
              <path
                d={pathD}
                fill="none"
                stroke={tokens.colors.accent.error}
                strokeWidth="3"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
                clipPath={`url(#clip-below-${period})`}
              />
            </>
          ) : (
            <>
              {/* Single-color fill (all values same sign) */}
              <path
                d={`${pathD} L 100,100 L 0,100 Z`}
                fill={`url(#gradient-${period}-${isPositive ? 'positive' : 'negative'})`}
                opacity="0.4"
              />
              {/* Single-color line */}
              <path
                d={pathD}
                fill="none"
                stroke={color}
                strokeWidth="3"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </>
          )}

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

          {/* Hover dot -- color matches whether point is above or below baseline */}
          {hoverIndex !== null && (() => {
            const cx = (hoverIndex / denominator) * width
            const val = validData[hoverIndex][dataKey] as number
            const cy = height - ((val - minValue) / range) * height
            const dotColor = hasBaseline
              ? (val >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error)
              : color
            return <circle cx={cx} cy={cy} r="4" fill={dotColor} stroke={tokens.colors.bg.primary} strokeWidth="2" vectorEffect="non-scaling-stroke" />
          })()}
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
            <Text size="sm" weight="bold" style={{ color: hasBaseline ? (hoverData[dataKey] >= 0 ? tokens.colors.accent.success : tokens.colors.accent.error) : color, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
              {formatTooltipValue(hoverData[dataKey])}
            </Text>
            {dataKey === 'roi' && hoverData.pnl != null && !isNaN(hoverData.pnl) && (
              <Text size="xs" color="tertiary" style={{ display: 'block', marginTop: 2, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                PnL: {formatTooltipValue(hoverData.pnl)}
              </Text>
            )}
            {dataKey === 'pnl' && hoverData.roi != null && !isNaN(hoverData.roi) && (
              <Text size="xs" color="tertiary" style={{ display: 'block', marginTop: 2, fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                ROI: {hoverData.roi >= 0 ? '+' : ''}{hoverData.roi.toFixed(2)}%
              </Text>
            )}
          </Box>
        )}
      </Box>

      {/* Zoom controls */}
      {allValidData.length > 8 && (
        <Box style={{
          position: 'absolute',
          top: tokens.spacing[3],
          right: tokens.spacing[3],
          display: 'flex',
          gap: 2,
          background: `${tokens.colors.bg.primary}E0`,
          borderRadius: tokens.radius.md,
          border: `1px solid ${tokens.colors.border.primary}40`,
          padding: 2,
          zIndex: 5,
        }}>
          <button
            onClick={() => setZoomLevel(prev => Math.min(prev * 2, Math.floor(allValidData.length / 4)))}
            disabled={zoomLevel >= Math.floor(allValidData.length / 4)}
            aria-label="Zoom in"
            style={{
              width: 24, height: 24, border: 'none', borderRadius: tokens.radius.sm,
              background: 'transparent', color: tokens.colors.text.secondary,
              cursor: zoomLevel >= Math.floor(allValidData.length / 4) ? 'not-allowed' : 'pointer',
              opacity: zoomLevel >= Math.floor(allValidData.length / 4) ? 0.3 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700,
            }}
          >+</button>
          <button
            onClick={() => { setZoomLevel(prev => Math.max(1, prev / 2)); setZoomOffset(0) }}
            disabled={zoomLevel <= 1}
            aria-label="Zoom out"
            style={{
              width: 24, height: 24, border: 'none', borderRadius: tokens.radius.sm,
              background: 'transparent', color: tokens.colors.text.secondary,
              cursor: zoomLevel <= 1 ? 'not-allowed' : 'pointer',
              opacity: zoomLevel <= 1 ? 0.3 : 1,
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700,
            }}
          >-</button>
        </Box>
      )}

      {/* X-axis Labels */}
      <Box style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginLeft: 55,
        marginTop: tokens.spacing[2],
      }}>
        <Text size="xs" color="tertiary" style={{ fontSize: 11 }}>
          {validData[0]?.date ? new Date(validData[0].date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
        {validData.length > 4 && (
          <Text size="xs" color="tertiary" style={{ fontSize: 11 }}>
            {new Date(validData[Math.floor(validData.length / 2)].date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' })}
          </Text>
        )}
        <Text size="xs" color="tertiary" style={{ fontSize: 11 }}>
          {validData[validData.length - 1]?.date ? new Date(validData[validData.length - 1].date).toLocaleDateString(locale, { month: 'numeric', day: 'numeric' }) : ''}
        </Text>
      </Box>
    </Box>
  )
}
