'use client'

import { useId } from 'react'

/**
 * Tiny equity-trend sparkline for the ROI cell (data from arena_roi_sparklines).
 * Shape-normalized (min→max over its own points) so it reads as a trajectory
 * regardless of absolute account size. Green if the account ended higher than it
 * started, red otherwise — semantic, theme-aware via the accent CSS vars.
 * Renders nothing (caller keeps the numeric fallback) when < 2 points.
 */
export function Sparkline({
  pts,
  width = 46,
  height = 20,
  up,
}: {
  pts: number[] | undefined
  width?: number
  height?: number
  /** Override the rise/fall color (defaults to last vs first point). */
  up?: boolean
}) {
  const gid = useId().replace(/:/g, '')
  if (!pts || pts.length < 2) return null

  const max = Math.max(...pts)
  const min = Math.min(...pts)
  const rng = max - min || 1
  const step = width / (pts.length - 1)
  const xy = pts.map((p, i): [number, number] => [
    i * step,
    height - 2 - ((p - min) / rng) * (height - 4),
  ])
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const rising = up ?? pts[pts.length - 1] >= pts[0]
  const c = rising ? 'var(--color-accent-success)' : 'var(--color-accent-error)'
  const end = xy[xy.length - 1]

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ flex: 'none', display: 'block' }}
    >
      <defs>
        <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor={c} stopOpacity="0.18" />
          <stop offset="1" stopColor={c} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line} L${width} ${height} L0 ${height} Z`} fill={`url(#${gid})`} />
      <path
        d={line}
        fill="none"
        stroke={c}
        strokeWidth="1.3"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={end[0].toFixed(1)} cy={end[1].toFixed(1)} r="1.6" fill={c} />
    </svg>
  )
}
