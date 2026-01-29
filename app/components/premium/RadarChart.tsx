'use client'

import React, { useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'

interface RadarDataPoint {
  label: string
  values: number[] // one per trader, 0-100 scale
}

interface RadarChartProps {
  data: RadarDataPoint[]
  traderNames: string[]
  colors?: string[]
  size?: number
}

const DEFAULT_COLORS = [
  '#8b5cf6', // purple
  '#06b6d4', // cyan
  '#f59e0b', // amber
  '#ef4444', // red
  '#10b981', // green
]

export default function RadarChart({
  data,
  traderNames,
  colors = DEFAULT_COLORS,
  size = 300,
}: RadarChartProps) {
  const center = size / 2
  const radius = size * 0.38
  const levels = 5

  const angleSlice = (Math.PI * 2) / data.length

  // Calculate polygon points for a given array of values
  const getPolygonPoints = useMemo(() => {
    return (values: number[]): string => {
      return values
        .map((val, i) => {
          const angle = angleSlice * i - Math.PI / 2
          const r = (val / 100) * radius
          const x = center + r * Math.cos(angle)
          const y = center + r * Math.sin(angle)
          return `${x},${y}`
        })
        .join(' ')
    }
  }, [angleSlice, center, radius])

  // Grid circles
  const gridCircles = useMemo(() => {
    return Array.from({ length: levels }, (_, i) => {
      const r = ((i + 1) / levels) * radius
      const points = Array.from({ length: data.length }, (_, j) => {
        const angle = angleSlice * j - Math.PI / 2
        return `${center + r * Math.cos(angle)},${center + r * Math.sin(angle)}`
      }).join(' ')
      return { r, points, level: i + 1 }
    })
  }, [levels, radius, data.length, angleSlice, center])

  // Axis lines and labels
  const axes = useMemo(() => {
    return data.map((d, i) => {
      const angle = angleSlice * i - Math.PI / 2
      const x2 = center + radius * Math.cos(angle)
      const y2 = center + radius * Math.sin(angle)
      const labelX = center + (radius + 20) * Math.cos(angle)
      const labelY = center + (radius + 20) * Math.sin(angle)
      return { ...d, x2, y2, labelX, labelY, angle }
    })
  }, [data, angleSlice, center, radius])

  const traderCount = traderNames.length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{ overflow: 'visible' }}
      >
        {/* Grid */}
        {gridCircles.map((circle) => (
          <polygon
            key={circle.level}
            points={circle.points}
            fill="none"
            stroke={tokens.colors.border.primary}
            strokeWidth={0.5}
            opacity={0.4}
          />
        ))}

        {/* Axis lines */}
        {axes.map((axis, i) => (
          <g key={i}>
            <line
              x1={center}
              y1={center}
              x2={axis.x2}
              y2={axis.y2}
              stroke={tokens.colors.border.primary}
              strokeWidth={0.5}
              opacity={0.4}
            />
            <text
              x={axis.labelX}
              y={axis.labelY}
              textAnchor="middle"
              dominantBaseline="middle"
              fill={tokens.colors.text.secondary}
              fontSize={11}
              fontWeight={500}
            >
              {axis.label}
            </text>
          </g>
        ))}

        {/* Data polygons */}
        {Array.from({ length: traderCount }, (_, traderIdx) => {
          const values = data.map(d => d.values[traderIdx] ?? 0)
          const points = getPolygonPoints(values)
          const color = colors[traderIdx % colors.length]

          return (
            <g key={traderIdx}>
              <polygon
                points={points}
                fill={color}
                fillOpacity={0.12}
                stroke={color}
                strokeWidth={2}
                strokeOpacity={0.8}
              />
              {/* Data points */}
              {values.map((val, i) => {
                const angle = angleSlice * i - Math.PI / 2
                const r = (val / 100) * radius
                const cx = center + r * Math.cos(angle)
                const cy = center + r * Math.sin(angle)
                return (
                  <circle
                    key={i}
                    cx={cx}
                    cy={cy}
                    r={3}
                    fill={color}
                    stroke="#fff"
                    strokeWidth={1}
                    opacity={0.9}
                  />
                )
              })}
            </g>
          )
        })}
      </svg>

      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center' }}>
        {traderNames.map((name, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 12,
                height: 12,
                borderRadius: 3,
                background: colors[i % colors.length],
                opacity: 0.85,
              }}
            />
            <span
              style={{
                fontSize: 12,
                color: tokens.colors.text.secondary,
                maxWidth: 80,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
