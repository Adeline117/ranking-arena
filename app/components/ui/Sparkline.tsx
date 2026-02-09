'use client'

import React, { memo } from 'react'
import { tokens } from '@/lib/design-tokens'

interface SparklineProps {
  /** Array of numeric values (e.g. daily ROI snapshots) */
  data?: number[]
  /** Final ROI value — used for fallback bar if no data */
  roi?: number
  width?: number
  height?: number
  /** Stroke color; defaults based on trend */
  color?: string
  className?: string
}

/**
 * Pure SVG sparkline — no chart library.
 * Falls back to a simple ROI bar if no curve data provided.
 */
export const Sparkline = memo(function Sparkline({
  data,
  roi,
  width = 80,
  height = 24,
  color,
  className,
}: SparklineProps) {
  // Fallback: ROI bar
  if (!data || data.length < 2) {
    const roiVal = roi ?? 0
    const isPositive = roiVal >= 0
    const barColor = color || (isPositive ? tokens.colors.sentiment.bull : tokens.colors.sentiment.bear)
    const barWidth = Math.min(Math.abs(roiVal) / 100, 1) * (width - 4)

    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        aria-label={`ROI ${roiVal >= 0 ? '+' : ''}${roiVal.toFixed(1)}%`}
      >
        {/* Background track */}
        <rect
          x={2}
          y={height / 2 - 3}
          width={width - 4}
          height={6}
          rx={3}
          fill="var(--glass-bg-light)"
        />
        {/* Value bar */}
        {barWidth > 0 && (
          <rect
            x={isPositive ? 2 : width / 2}
            y={height / 2 - 3}
            width={Math.max(barWidth, 2)}
            height={6}
            rx={3}
            fill={barColor}
            opacity={0.7}
          />
        )}
      </svg>
    )
  }

  // Sparkline curve
  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const padding = 2

  const effectiveW = width - padding * 2
  const effectiveH = height - padding * 2

  const points = data.map((v, i) => {
    const x = padding + (i / (data.length - 1)) * effectiveW
    const y = padding + effectiveH - ((v - min) / range) * effectiveH
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  const isUp = data[data.length - 1] >= data[0]
  const strokeColor = color || (isUp ? tokens.colors.sentiment.bull : tokens.colors.sentiment.bear)

  // Area fill path
  const areaPath = `M${points[0]} ${points.slice(1).map(p => `L${p}`).join(' ')} L${(padding + effectiveW).toFixed(1)},${(padding + effectiveH).toFixed(1)} L${padding},${(padding + effectiveH).toFixed(1)} Z`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-label="ROI curve"
    >
      <defs>
        <linearGradient id={`spark-fill-${isUp ? 'up' : 'down'}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity={0.3} />
          <stop offset="100%" stopColor={strokeColor} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#spark-fill-${isUp ? 'up' : 'down'})`} />
      <polyline
        points={points.join(' ')}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
})

export default Sparkline
