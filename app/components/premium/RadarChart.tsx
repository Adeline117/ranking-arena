'use client'

import { useMemo } from 'react'

interface RadarChartProps {
  data: Array<{ label: string; values: number[] }>
  traderNames: string[]
  colors?: string[]
  size?: number
}

const DEFAULT_COLORS = [
  'var(--color-accent-brand, #6366f1)',
  'var(--color-enterprise-gradient-start, #06b6d4)',
  'var(--color-score-average, #f59e0b)',
  'var(--color-score-great, #10b981)',
  'var(--color-accent-error, #ef4444)',
]

/**
 * Pure SVG radar chart for trader comparison.
 * No external deps -- lightweight and SSR-safe.
 */
export default function RadarChart({
  data,
  traderNames,
  colors = DEFAULT_COLORS,
  size = 300,
}: RadarChartProps) {
  const axes = data.length

  const angles = useMemo(
    () =>
      Array.from({ length: axes }, (_, i) => {
        const angle = (Math.PI * 2 * i) / axes - Math.PI / 2
        return { cos: Math.cos(angle), sin: Math.sin(angle) }
      }),
    [axes],
  )

  if (axes < 3) return null

  const cx = size / 2
  const cy = size / 2
  const radius = (size / 2) * 0.65
  const labelOffset = radius + 28
  const rings = [0.2, 0.4, 0.6, 0.8, 1.0]

  const buildPolygon = (values: number[]): string =>
    values
      .map((v, i) => {
        const r = (Math.min(Math.max(v, 0), 100) / 100) * radius
        return `${cx + r * angles[i].cos},${cy + r * angles[i].sin}`
      })
      .join(' ')

  const traderCount = data[0]?.values.length ?? 0

  return (
    <div style={{ position: 'relative', width: '100%', maxWidth: size, aspectRatio: `${size} / ${size + 24}` }}>
      <svg viewBox={`0 0 ${size} ${size}`} style={{ width: '100%', height: 'auto', overflow: 'visible' }}>
        {rings.map((pct) => (
          <polygon
            key={pct}
            points={angles.map((a) => `${cx + radius * pct * a.cos},${cy + radius * pct * a.sin}`).join(' ')}
            fill="none" stroke="var(--color-border-primary, #2a2a3e)" strokeWidth={1} opacity={0.5}
          />
        ))}
        {angles.map((a, i) => (
          <line key={i} x1={cx} y1={cy} x2={cx + radius * a.cos} y2={cy + radius * a.sin}
            stroke="var(--color-border-primary, #2a2a3e)" strokeWidth={1} opacity={0.4} />
        ))}
        {Array.from({ length: traderCount }, (_, tIdx) => {
          const values = data.map((d) => d.values[tIdx] ?? 0)
          const color = colors[tIdx % colors.length]
          return (
            <g key={tIdx}>
              <polygon points={buildPolygon(values)} fill={color} fillOpacity={0.12}
                stroke={color} strokeWidth={2} strokeLinejoin="round" />
              {values.map((v, i) => {
                const r = (Math.min(Math.max(v, 0), 100) / 100) * radius
                return (
                  <circle key={i} cx={cx + r * angles[i].cos} cy={cy + r * angles[i].sin}
                    r={3} fill={color} stroke="var(--color-bg-primary, #0f0f23)" strokeWidth={1.5} />
                )
              })}
            </g>
          )
        })}
        {data.map((d, i) => {
          const x = cx + labelOffset * angles[i].cos
          const y = cy + labelOffset * angles[i].sin
          const anchor = Math.abs(angles[i].cos) < 0.1 ? 'middle' : angles[i].cos > 0 ? 'start' : 'end'
          return (
            <text key={i} x={x} y={y} textAnchor={anchor} dominantBaseline="central"
              fill="var(--color-text-secondary, #9ca3af)" fontSize={11} fontWeight={500}
              fontFamily="var(--font-mono, monospace)">
              {d.label}
            </text>
          )
        })}
      </svg>
      <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        {traderNames.map((name, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11,
            color: 'var(--color-text-secondary, #9ca3af)' }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%',
              background: colors[i % colors.length], flexShrink: 0 }} />
            <span style={{ maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
