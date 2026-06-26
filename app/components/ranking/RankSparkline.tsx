'use client'

interface RankDataPoint {
  rank: number
}

interface RankSparklineProps {
  data: RankDataPoint[]
  width?: number
  height?: number
}

/**
 * Inline SVG sparkline showing 7-day rank trajectory.
 * Lower rank = better = higher line position.
 * Green if rank improved, red if worsened, gray if unchanged.
 */
export function RankSparkline({ data, width = 60, height = 20 }: RankSparklineProps) {
  if (data.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="No rank history"
      >
        {/* No-history state: a short centered dash reads as intentional
            "no trend yet" rather than a faint full-width line that looks broken. */}
        <line
          x1={width * 0.32}
          y1={height / 2}
          x2={width * 0.68}
          y2={height / 2}
          stroke="var(--color-text-tertiary)"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray="2,3"
          opacity={0.55}
        />
      </svg>
    )
  }

  const ranks = data.map((d) => d.rank)
  const min = Math.min(...ranks)
  const max = Math.max(...ranks)
  const range = max - min || 1

  const flat = max === min
  const coords = data.map((d, i) => {
    const x = (i / (data.length - 1)) * width
    // Invert: lower rank (better) = higher y position on the chart.
    // A flat (unchanged) series centers vertically instead of pinning to the top.
    const y = flat ? height / 2 : ((d.rank - min) / range) * (height - 2) + 1
    return { x, y }
  })
  const linePoints = coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')
  const areaPath = `M${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' L')} L${width},${height} L0,${height} Z`
  const lastPt = coords[coords.length - 1]

  const firstRank = data[0].rank
  const lastRank = data[data.length - 1].rank
  const color =
    lastRank < firstRank
      ? 'var(--color-accent-success)' // improved (lower rank = better)
      : lastRank > firstRank
        ? 'var(--color-accent-error)' // worsened
        : 'var(--color-text-tertiary)' // unchanged
  const gradId = `rank-spark-${firstRank}-${lastRank}-${width}-${height}`

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`Rank trend: ${firstRank} → ${lastRank}`}
      role="img"
      style={{ overflow: 'visible' }}
    >
      {/* Area fill + thicker line + end dot for legibility at small size. */}
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.22} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradId})`} />
      <polyline
        points={linePoints}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle
        cx={lastPt.x}
        cy={lastPt.y}
        r={2.2}
        fill={color}
        stroke="var(--color-bg-primary)"
        strokeWidth={1}
      />
    </svg>
  )
}
