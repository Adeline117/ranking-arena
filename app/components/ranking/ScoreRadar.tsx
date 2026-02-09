'use client'

import React, { memo } from 'react'
import { getScoreColor } from '@/lib/utils/score-colors'

interface ScoreRadarProps {
  profitability: number  // 0-35
  riskControl: number    // 0-40
  execution: number      // 0-25
  arenaScore: number     // 0-100, for color
  size?: number
}

/**
 * 三角形雷达图 - SVG自绘
 * 三个轴：收益能力、风险控制、执行质量
 */
export const ScoreRadar = memo(function ScoreRadar({
  profitability,
  riskControl,
  execution,
  arenaScore,
  size = 120,
}: ScoreRadarProps) {
  const cx = size / 2
  const cy = size / 2
  const r = size * 0.38 // max radius

  // Normalize to 0-1
  const pNorm = Math.min(profitability / 35, 1)
  const rNorm = Math.min(riskControl / 40, 1)
  const eNorm = Math.min(execution / 25, 1)

  // Three axes at 120 degree intervals, starting from top
  // Top: 收益能力, Bottom-left: 风险控制, Bottom-right: 执行质量
  const angles = [-Math.PI / 2, -Math.PI / 2 + (2 * Math.PI / 3), -Math.PI / 2 + (4 * Math.PI / 3)]

  const getPoint = (angle: number, ratio: number) => ({
    x: cx + r * ratio * Math.cos(angle),
    y: cy + r * ratio * Math.sin(angle),
  })

  // Background grid lines
  const gridLevels = [0.33, 0.66, 1.0]
  const gridPaths = gridLevels.map(level => {
    const pts = angles.map(a => getPoint(a, level))
    return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y} L${pts[2].x},${pts[2].y} Z`
  })

  // Axis lines
  const axisLines = angles.map(a => {
    const end = getPoint(a, 1)
    return `M${cx},${cy} L${end.x},${end.y}`
  })

  // Data shape
  const values = [pNorm, rNorm, eNorm]
  const dataPoints = angles.map((a, i) => getPoint(a, Math.max(values[i], 0.05)))
  const dataPath = `M${dataPoints[0].x},${dataPoints[0].y} L${dataPoints[1].x},${dataPoints[1].y} L${dataPoints[2].x},${dataPoints[2].y} Z`

  const color = getScoreColor(arenaScore)
  const labelFontSize = Math.max(size * 0.08, 9)

  // Label positions (slightly outside the triangle)
  const labelOffset = r + 14
  const labels = [
    { text: '收益', x: cx, y: cy - labelOffset },
    { text: '风控', x: cx + labelOffset * Math.cos(angles[1]) - 4, y: cy + labelOffset * Math.sin(angles[1]) + 4 },
    { text: '执行', x: cx + labelOffset * Math.cos(angles[2]) + 4, y: cy + labelOffset * Math.sin(angles[2]) + 4 },
  ]

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ overflow: 'visible' }}>
      {/* Grid */}
      {gridPaths.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--color-border-secondary)" strokeWidth={0.5} opacity={0.5} />
      ))}
      {/* Axes */}
      {axisLines.map((d, i) => (
        <path key={`axis-${i}`} d={d} stroke="var(--color-border-secondary)" strokeWidth={0.5} opacity={0.4} />
      ))}
      {/* Data fill */}
      <path d={dataPath} fill={color} fillOpacity={0.2} stroke={color} strokeWidth={1.5} />
      {/* Data points */}
      {dataPoints.map((pt, i) => (
        <circle key={`pt-${i}`} cx={pt.x} cy={pt.y} r={2.5} fill={color} />
      ))}
      {/* Labels */}
      {labels.map((l, i) => (
        <text
          key={`label-${i}`}
          x={l.x}
          y={l.y}
          textAnchor="middle"
          dominantBaseline="middle"
          fill="var(--color-text-tertiary)"
          fontSize={labelFontSize}
          fontWeight={600}
        >
          {l.text}
        </text>
      ))}
    </svg>
  )
})

export default ScoreRadar
