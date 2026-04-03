'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'

interface DailyReturnsChartProps {
  data: { date: string; returnPct: number }[]
}

interface Bucket {
  label: string
  min: number
  max: number
  color: string
  count: number
}

const CHART_WIDTH = 400
const CHART_HEIGHT = 200
const PADDING = { top: 20, right: 20, bottom: 40, left: 40 }
const INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right
const INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom

function computeStats(data: { returnPct: number }[]) {
  if (data.length === 0) return { mean: 0, median: 0 }
  const values = data.map(d => d.returnPct).sort((a, b) => a - b)
  const mean = values.reduce((s, v) => s + v, 0) / values.length
  const mid = Math.floor(values.length / 2)
  const median = values.length % 2 === 0
    ? (values[mid - 1] + values[mid]) / 2
    : values[mid]
  return { mean, median }
}

export function DailyReturnsChart({ data }: DailyReturnsChartProps) {
  const { t } = useLanguage()
  const [hoverBucket, setHoverBucket] = useState<number | null>(null)

  if (!data || data.length === 0) {
    return (
      <div style={{
        padding: tokens.spacing[4],
        color: tokens.colors.text.tertiary,
        fontSize: tokens.typography.fontSize.sm,
        textAlign: 'center',
      }}>
        {t('noData')}
      </div>
    )
  }

  const bucketDefs: Omit<Bucket, 'count'>[] = [
    { label: '<-5%', min: -Infinity, max: -5, color: '#ef4444' },
    { label: '-5~-2%', min: -5, max: -2, color: '#f87171' },
    { label: '-2~0%', min: -2, max: 0, color: '#fca5a5' },
    { label: '0~2%', min: 0, max: 2, color: '#86efac' },
    { label: '2~5%', min: 2, max: 5, color: '#4ade80' },
    { label: '>5%', min: 5, max: Infinity, color: '#22c55e' },
  ]

  const buckets: Bucket[] = bucketDefs.map(b => ({ ...b, count: 0 }))

  for (const point of data) {
    const v = point.returnPct
    for (const bucket of buckets) {
      if (v >= bucket.min && v < bucket.max) {
        bucket.count++
        break
      }
    }
    // Handle exact upper boundary for last bucket
    if (v >= buckets[buckets.length - 1].min) {
      // Already counted above via >= check
    }
  }

  const maxCount = Math.max(...buckets.map(b => b.count), 1)
  const { mean, median } = computeStats(data)

  const barWidth = INNER_WIDTH / buckets.length
  const barGap = 4

  // Map a return value to X position within the chart
  // Buckets are evenly spaced, so we map based on bucket index
  function valueToX(value: number): number {
    // Find which bucket this value falls into
    for (let i = 0; i < buckets.length; i++) {
      if (value >= buckets[i].min && value < buckets[i].max) {
        // Interpolate within the bucket
        const bucketRange = buckets[i].max === Infinity ? 10 : buckets[i].min === -Infinity ? 10 : buckets[i].max - buckets[i].min
        const effectiveMin = buckets[i].min === -Infinity ? buckets[i].max - 10 : buckets[i].min
        const fraction = bucketRange > 0 ? (value - effectiveMin) / bucketRange : 0.5
        return PADDING.left + i * barWidth + fraction * barWidth
      }
    }
    // Fallback: far right
    return PADDING.left + INNER_WIDTH
  }

  const meanX = valueToX(mean)
  const medianX = valueToX(median)

  return (
    <div style={{ width: '100%' }}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        style={{ width: '100%', height: 'auto' }}
        role="img"
        aria-label="Daily returns distribution chart"
      >
        {/* Y-axis gridlines */}
        {[0, 0.25, 0.5, 0.75, 1].map(frac => {
          const y = PADDING.top + INNER_HEIGHT * (1 - frac)
          const val = Math.round(maxCount * frac)
          return (
            <g key={frac}>
              <line
                x1={PADDING.left}
                y1={y}
                x2={PADDING.left + INNER_WIDTH}
                y2={y}
                stroke="var(--color-border-primary)"
                strokeWidth={0.5}
                strokeDasharray={frac > 0 ? '2,2' : undefined}
              />
              <text
                x={PADDING.left - 6}
                y={y + 3}
                textAnchor="end"
                fill="var(--color-text-tertiary)"
                fontSize={9}
              >
                {val}
              </text>
            </g>
          )
        })}

        {/* Bars */}
        {buckets.map((bucket, i) => {
          const barH = maxCount > 0 ? (bucket.count / maxCount) * INNER_HEIGHT : 0
          const x = PADDING.left + i * barWidth + barGap / 2
          const y = PADDING.top + INNER_HEIGHT - barH
          return (
            <g key={bucket.label}>
              <rect
                x={x}
                y={y}
                width={barWidth - barGap}
                height={barH}
                fill={bucket.color}
                rx={2}
                opacity={hoverBucket === null || hoverBucket === i ? 1 : 0.4}
                style={{ transition: 'opacity 0.15s ease', cursor: 'pointer' }}
                onMouseEnter={() => setHoverBucket(i)}
                onMouseLeave={() => setHoverBucket(null)}
              />
              {/* Count label on top of bar */}
              {bucket.count > 0 && (
                <text
                  x={x + (barWidth - barGap) / 2}
                  y={y - 4}
                  textAnchor="middle"
                  fill="var(--color-text-secondary)"
                  fontSize={9}
                  fontWeight={600}
                >
                  {bucket.count}
                </text>
              )}
              {/* X-axis label */}
              <text
                x={x + (barWidth - barGap) / 2}
                y={PADDING.top + INNER_HEIGHT + 14}
                textAnchor="middle"
                fill="var(--color-text-tertiary)"
                fontSize={8}
              >
                {bucket.label}
              </text>
            </g>
          )
        })}

        {/* Mean line */}
        <line
          x1={meanX}
          y1={PADDING.top}
          x2={meanX}
          y2={PADDING.top + INNER_HEIGHT}
          stroke="#f59e0b"
          strokeWidth={1.5}
          strokeDasharray="4,3"
        />
        <text
          x={meanX + 3}
          y={PADDING.top + 10}
          fill="#f59e0b"
          fontSize={8}
          fontWeight={600}
        >
          Mean {mean.toFixed(1)}%
        </text>

        {/* Median line */}
        <line
          x1={medianX}
          y1={PADDING.top}
          x2={medianX}
          y2={PADDING.top + INNER_HEIGHT}
          stroke="#8b5cf6"
          strokeWidth={1.5}
          strokeDasharray="4,3"
        />
        <text
          x={medianX + 3}
          y={PADDING.top + 20}
          fill="#8b5cf6"
          fontSize={8}
          fontWeight={600}
        >
          Median {median.toFixed(1)}%
        </text>

        {/* Y-axis label */}
        <text
          x={6}
          y={PADDING.top + INNER_HEIGHT / 2}
          textAnchor="middle"
          fill="var(--color-text-tertiary)"
          fontSize={8}
          transform={`rotate(-90, 6, ${PADDING.top + INNER_HEIGHT / 2})`}
        >
          Days
        </text>

        {/* Hover tooltip */}
        {hoverBucket !== null && buckets[hoverBucket].count > 0 && (() => {
          const b = buckets[hoverBucket]
          const bx = PADDING.left + hoverBucket * barWidth + barWidth / 2
          const bBarH = (b.count / maxCount) * INNER_HEIGHT
          const by = PADDING.top + INNER_HEIGHT - bBarH - 28
          const pct = ((b.count / data.length) * 100).toFixed(1)
          return (
            <g>
              <rect
                x={bx - 40} y={by} width={80} height={24} rx={4}
                fill="var(--color-bg-primary)" stroke="var(--color-border-primary)" strokeWidth={0.5}
              />
              <text x={bx} y={by + 10} textAnchor="middle" fill="var(--color-text-primary)" fontSize={8} fontWeight={600}>
                {b.count} days ({pct}%)
              </text>
              <text x={bx} y={by + 20} textAnchor="middle" fill="var(--color-text-tertiary)" fontSize={7}>
                {b.label}
              </text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}
