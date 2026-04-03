'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'

interface DrawdownChartProps {
  equityCurve: { date: string; roi: number }[]
}

const CHART_WIDTH = 400
const CHART_HEIGHT = 160
const PADDING = { top: 16, right: 16, bottom: 30, left: 48 }
const INNER_WIDTH = CHART_WIDTH - PADDING.left - PADDING.right
const INNER_HEIGHT = CHART_HEIGHT - PADDING.top - PADDING.bottom

export function DrawdownChart({ equityCurve }: DrawdownChartProps) {
  const { t } = useLanguage()

  if (!equityCurve || equityCurve.length < 2) {
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

  // Compute drawdown series
  let peak = -Infinity
  const drawdowns = equityCurve.map(p => {
    peak = Math.max(peak, p.roi)
    const dd = peak > 0 ? ((p.roi - peak) / peak) * 100 : 0
    return { date: p.date, drawdown: Math.min(dd, 0) }
  })

  const minDrawdown = Math.min(...drawdowns.map(d => d.drawdown), 0)

  // If no drawdown at all, show a "no drawdown" message
  if (minDrawdown === 0) {
    return (
      <div style={{
        padding: tokens.spacing[4],
        color: tokens.colors.accent.success,
        fontSize: tokens.typography.fontSize.sm,
        textAlign: 'center',
      }}>
        ✓ No drawdown recorded
      </div>
    )
  }

  // Y range: minDrawdown to 0
  const yRange = Math.abs(minDrawdown) || 1

  // Map data index to X
  const xStep = INNER_WIDTH / Math.max(drawdowns.length - 1, 1)

  // Build SVG path for the area fill
  const points = drawdowns.map((d, i) => {
    const x = PADDING.left + i * xStep
    const y = PADDING.top + (Math.abs(d.drawdown) / yRange) * INNER_HEIGHT
    return { x, y }
  })

  // Area: top edge is 0 line, fill down to drawdown line
  const areaPath = [
    `M ${points[0].x} ${PADDING.top}`,
    ...points.map(p => `L ${p.x} ${p.y}`),
    `L ${points[points.length - 1].x} ${PADDING.top}`,
    'Z',
  ].join(' ')

  // Line path (just the drawdown curve)
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ')

  // Y-axis ticks
  const yTicks = [0, -yRange * 0.25, -yRange * 0.5, -yRange * 0.75, -yRange].filter(
    v => Math.abs(v) <= yRange
  )

  // X-axis labels (show ~5 dates)
  const labelCount = Math.min(5, drawdowns.length)
  const labelStep = Math.max(1, Math.floor((drawdowns.length - 1) / (labelCount - 1)))
  const xLabels: { x: number; label: string }[] = []
  for (let i = 0; i < drawdowns.length; i += labelStep) {
    const dateStr = drawdowns[i].date
    const short = dateStr.length >= 10 ? dateStr.slice(5, 10) : dateStr
    xLabels.push({ x: PADDING.left + i * xStep, label: short })
  }
  // Always include last
  if (xLabels.length > 0) {
    const lastDate = drawdowns[drawdowns.length - 1].date
    const lastShort = lastDate.length >= 10 ? lastDate.slice(5, 10) : lastDate
    const lastX = PADDING.left + (drawdowns.length - 1) * xStep
    if (Math.abs(lastX - xLabels[xLabels.length - 1].x) > 30) {
      xLabels.push({ x: lastX, label: lastShort })
    }
  }

  return (
    <div style={{ width: '100%' }}>
      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        style={{ width: '100%', height: 'auto' }}
        role="img"
        aria-label="Underwater drawdown chart"
      >
        {/* Gradient definition */}
        <defs>
          <linearGradient id="drawdown-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ef4444" stopOpacity={0.05} />
            <stop offset="100%" stopColor="#ef4444" stopOpacity={0.3} />
          </linearGradient>
        </defs>

        {/* Y-axis gridlines and labels */}
        {yTicks.map(tick => {
          const y = PADDING.top + (Math.abs(tick) / yRange) * INNER_HEIGHT
          return (
            <g key={tick}>
              <line
                x1={PADDING.left}
                y1={y}
                x2={PADDING.left + INNER_WIDTH}
                y2={y}
                stroke="var(--color-border-primary)"
                strokeWidth={0.5}
                strokeDasharray={tick === 0 ? undefined : '2,2'}
              />
              <text
                x={PADDING.left - 6}
                y={y + 3}
                textAnchor="end"
                fill="var(--color-text-tertiary)"
                fontSize={8}
              >
                {tick === 0 ? '0%' : `${tick.toFixed(Math.abs(tick) < 1 ? 2 : 1)}%`}
              </text>
            </g>
          )
        })}

        {/* Area fill */}
        <path d={areaPath} fill="url(#drawdown-fill)" />

        {/* Line */}
        <path d={linePath} fill="none" stroke="#ef4444" strokeWidth={1.5} />

        {/* 0% baseline (bold) */}
        <line
          x1={PADDING.left}
          y1={PADDING.top}
          x2={PADDING.left + INNER_WIDTH}
          y2={PADDING.top}
          stroke="var(--color-text-tertiary)"
          strokeWidth={1}
        />

        {/* X-axis labels */}
        {xLabels.map((lbl, i) => (
          <text
            key={i}
            x={lbl.x}
            y={CHART_HEIGHT - 6}
            textAnchor="middle"
            fill="var(--color-text-tertiary)"
            fontSize={8}
          >
            {lbl.label}
          </text>
        ))}

        {/* Max drawdown annotation */}
        {minDrawdown < 0 && (() => {
          const minIdx = drawdowns.findIndex(d => d.drawdown === minDrawdown)
          if (minIdx < 0) return null
          const px = points[minIdx].x
          const py = points[minIdx].y
          return (
            <g>
              <circle cx={px} cy={py} r={3} fill="#ef4444" />
              <text
                x={px}
                y={py + 12}
                textAnchor="middle"
                fill="#ef4444"
                fontSize={8}
                fontWeight={600}
              >
                {minDrawdown.toFixed(1)}%
              </text>
            </g>
          )
        })()}
      </svg>
    </div>
  )
}
