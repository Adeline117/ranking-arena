'use client'

import { useMemo } from 'react'

interface SparklineProps {
  prices: number[]
  width?: number
  height?: number
  /** Override color direction; defaults to auto-detect from first/last price */
  positive?: boolean
}

/**
 * Compact 7-day price sparkline rendered as a pure SVG path.
 * No chart library — lightweight inline SVG only.
 * Green stroke if price trended up, red if down.
 */
export default function Sparkline({ prices, width = 88, height = 34, positive }: SparklineProps) {
  const path = useMemo(() => {
    if (!prices || prices.length < 2) return null

    // Downsample to at most 30 points for visual clarity
    const pts = downsample(prices, 30)

    const minVal = Math.min(...pts)
    const maxVal = Math.max(...pts)
    const range = maxVal - minVal || 1

    const padding = 2
    const w = width - padding * 2
    const h = height - padding * 2

    const toX = (i: number) => padding + (i / (pts.length - 1)) * w
    const toY = (v: number) => padding + h - ((v - minVal) / range) * h

    // Smooth path using cardinal-spline-style control points (simple averaging)
    const d = pts
      .map((v, i) => {
        const x = toX(i)
        const y = toY(v)
        if (i === 0) return `M${x.toFixed(1)},${y.toFixed(1)}`

        // Simple quadratic-like smoothing via midpoints
        const px = toX(i - 1)
        const py = toY(pts[i - 1])
        const mx = ((px + x) / 2).toFixed(1)
        return `Q${mx},${py.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

    const isUp = positive !== undefined ? positive : pts[pts.length - 1] >= pts[0]
    const color = isUp
      ? 'var(--color-accent-success, #22c55e)'
      : 'var(--color-accent-error, #ef4444)'

    return { d, color }
  }, [prices, width, height, positive])

  if (!path) {
    return <span style={{ display: 'inline-block', width, height }} />
  }

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ display: 'block', flexShrink: 0 }}
      aria-hidden="true"
    >
      <path
        d={path.d}
        fill="none"
        stroke={path.color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

/**
 * Downsample an array to at most `n` evenly-spaced values.
 * Always includes first and last element.
 */
function downsample(arr: number[], n: number): number[] {
  if (arr.length <= n) return arr
  const result: number[] = []
  const step = (arr.length - 1) / (n - 1)
  for (let i = 0; i < n; i++) {
    result.push(arr[Math.round(i * step)])
  }
  return result
}
