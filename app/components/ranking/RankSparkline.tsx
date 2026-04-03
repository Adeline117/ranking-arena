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
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="No rank history">
        <line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="#9ca3af" strokeWidth={1} strokeDasharray="3,3" opacity={0.4} />
      </svg>
    )
  }

  const ranks = data.map(d => d.rank)
  const min = Math.min(...ranks)
  const max = Math.max(...ranks)
  const range = max - min || 1

  const points = data
    .map((d, i) => {
      const x = (i / (data.length - 1)) * width
      // Invert: lower rank (better) = higher y position on the chart
      const y = ((d.rank - min) / range) * (height - 2) + 1
      return `${x.toFixed(1)},${y.toFixed(1)}`
    })
    .join(' ')

  const firstRank = data[0].rank
  const lastRank = data[data.length - 1].rank
  const color =
    lastRank < firstRank
      ? '#22c55e' // improved (lower rank = better)
      : lastRank > firstRank
        ? '#ef4444' // worsened
        : '#9ca3af' // unchanged

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-label={`Rank trend: ${firstRank} → ${lastRank}`}
      role="img"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
