'use client'

import { useState, useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../../Providers/LanguageProvider'

interface PnlCalendarHeatmapProps {
  /** Equity curve data with date, roi, and pnl per day */
  data: Array<{ date: string; roi: number; pnl: number }>
  /** Number of days to show (default 90) */
  days?: number
}

interface DayData {
  date: string
  pnl: number
  roi: number
}

// Color intensity levels for profit/loss
const PROFIT_COLORS = [
  'rgba(47, 229, 125, 0.15)',  // very light green
  'rgba(47, 229, 125, 0.35)',  // light green
  'rgba(47, 229, 125, 0.55)',  // medium green
  'rgba(47, 229, 125, 0.75)',  // strong green
  'rgba(47, 229, 125, 0.95)',  // intense green
]

const LOSS_COLORS = [
  'rgba(255, 124, 124, 0.15)',  // very light red
  'rgba(255, 124, 124, 0.35)',  // light red
  'rgba(255, 124, 124, 0.55)',  // medium red
  'rgba(255, 124, 124, 0.75)',  // strong red
  'rgba(255, 124, 124, 0.95)',  // intense red
]

const NO_DATA_COLOR = 'var(--color-bg-tertiary)'

function getColor(pnl: number, maxAbsPnl: number): string {
  if (pnl === 0) return NO_DATA_COLOR
  const intensity = Math.min(Math.abs(pnl) / maxAbsPnl, 1)
  const index = Math.min(Math.floor(intensity * 5), 4)
  return pnl > 0 ? PROFIT_COLORS[index] : LOSS_COLORS[index]
}

const DAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', '']

export function PnlCalendarHeatmap({ data, days = 90 }: PnlCalendarHeatmapProps) {
  const { t } = useLanguage()
  const [tooltip, setTooltip] = useState<{ x: number; y: number; day: DayData } | null>(null)

  const { grid, weeks, monthLabels, maxAbsPnl } = useMemo(() => {
    if (!data || data.length === 0) return { grid: [], weeks: 0, monthLabels: [], maxAbsPnl: 0 }

    // Build a map of date -> daily PnL change
    const dailyMap = new Map<string, DayData>()

    // Compute daily PnL deltas from the equity curve
    for (let i = 1; i < data.length; i++) {
      const curr = data[i]
      const prev = data[i - 1]
      const dailyPnl = curr.pnl - prev.pnl
      const dailyRoi = curr.roi - prev.roi
      dailyMap.set(curr.date, { date: curr.date, pnl: dailyPnl, roi: dailyRoi })
    }

    // Generate last N days
    const today = new Date()
    const startDate = new Date(today)
    startDate.setDate(startDate.getDate() - days + 1)

    // Align start to the beginning of the week (Sunday)
    const startDay = startDate.getDay()
    startDate.setDate(startDate.getDate() - startDay)

    const gridData: (DayData | null)[] = []
    const current = new Date(startDate)
    const endDate = new Date(today)

    while (current <= endDate) {
      const dateStr = current.toISOString().split('T')[0]
      const dayData = dailyMap.get(dateStr) || null
      gridData.push(dayData)
      current.setDate(current.getDate() + 1)
    }

    // Pad to full weeks
    while (gridData.length % 7 !== 0) {
      gridData.push(null)
    }

    const numWeeks = Math.ceil(gridData.length / 7)

    // Month labels
    const labels: Array<{ label: string; week: number }> = []
    let lastMonth = -1
    for (let i = 0; i < gridData.length; i++) {
      const weekIndex = Math.floor(i / 7)
      const dayIndex = i % 7
      if (dayIndex !== 0) continue // Only check first day of each week
      const d = new Date(startDate)
      d.setDate(d.getDate() + i)
      if (d.getMonth() !== lastMonth) {
        lastMonth = d.getMonth()
        const monthName = d.toLocaleString('en', { month: 'short' })
        labels.push({ label: monthName, week: weekIndex })
      }
    }

    // Max absolute PnL for color scaling
    const pnlValues = Array.from(dailyMap.values()).map(d => Math.abs(d.pnl))
    const maxPnl = pnlValues.length > 0 ? Math.max(...pnlValues) : 1

    return { grid: gridData, weeks: numWeeks, monthLabels: labels, maxAbsPnl: maxPnl }
  }, [data, days])

  if (!data || data.length < 3) {
    return null
  }

  const cellSize = 14
  const cellGap = 2
  const totalCellSize = cellSize + cellGap
  const labelWidth = 28
  const topPadding = 20
  const svgWidth = labelWidth + weeks * totalCellSize + 10
  const svgHeight = topPadding + 7 * totalCellSize + 10

  return (
    <div style={{ position: 'relative' }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: tokens.spacing[3],
      }}>
        <span style={{
          fontSize: tokens.typography.fontSize.sm,
          fontWeight: tokens.typography.fontWeight.bold,
          color: 'var(--color-text-secondary)',
        }}>
          {t('dailyPnlHeatmap')}
        </span>

        {/* Legend */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
          <span style={{ color: 'var(--color-text-tertiary)' }}>{t('loss')}</span>
          {LOSS_COLORS.slice().reverse().map((c, i) => (
            <div key={`loss-${i}`} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
          ))}
          <div style={{ width: 10, height: 10, borderRadius: 2, background: NO_DATA_COLOR }} />
          {PROFIT_COLORS.map((c, i) => (
            <div key={`profit-${i}`} style={{ width: 10, height: 10, borderRadius: 2, background: c }} />
          ))}
          <span style={{ color: 'var(--color-text-tertiary)' }}>{t('profit')}</span>
        </div>
      </div>

      {/* Heatmap */}
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        style={{ width: '100%', height: 'auto' }}
        role="img"
        aria-label="PnL calendar heatmap"
      >
        {/* Month labels */}
        {monthLabels.map(({ label, week }, i) => (
          <text
            key={i}
            x={labelWidth + week * totalCellSize}
            y={12}
            fill="var(--color-text-tertiary)"
            fontSize={9}
          >
            {label}
          </text>
        ))}

        {/* Day labels */}
        {DAY_LABELS.map((label, i) => (
          label ? (
            <text
              key={i}
              x={0}
              y={topPadding + i * totalCellSize + cellSize - 2}
              fill="var(--color-text-tertiary)"
              fontSize={8}
              textAnchor="start"
            >
              {label}
            </text>
          ) : null
        ))}

        {/* Cells */}
        {grid.map((day, i) => {
          const week = Math.floor(i / 7)
          const dayOfWeek = i % 7
          const x = labelWidth + week * totalCellSize
          const y = topPadding + dayOfWeek * totalCellSize
          const color = day ? getColor(day.pnl, maxAbsPnl) : NO_DATA_COLOR

          return (
            <rect
              key={i}
              x={x}
              y={y}
              width={cellSize}
              height={cellSize}
              rx={2}
              fill={color}
              stroke="none"
              style={{ cursor: day ? 'pointer' : 'default' }}
              onMouseEnter={(e) => {
                if (day) {
                  const rect = (e.target as SVGRectElement).getBoundingClientRect()
                  const parent = (e.target as SVGRectElement).closest('div')?.getBoundingClientRect()
                  if (parent) {
                    setTooltip({
                      x: rect.left - parent.left + rect.width / 2,
                      y: rect.top - parent.top - 8,
                      day,
                    })
                  }
                }
              }}
              onMouseLeave={() => setTooltip(null)}
            />
          )
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)',
            padding: '6px 10px',
            background: 'var(--color-bg-primary)',
            border: '1px solid var(--color-border-primary)',
            borderRadius: tokens.radius.md,
            boxShadow: tokens.shadow.md,
            zIndex: tokens.zIndex.tooltip,
            pointerEvents: 'none',
            whiteSpace: 'nowrap',
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 2 }}>
            {tooltip.day.date}
          </div>
          <div style={{ color: tooltip.day.pnl >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)' }}>
            PnL: {tooltip.day.pnl >= 0 ? '+' : ''}{tooltip.day.pnl < 1000 && tooltip.day.pnl > -1000
              ? `$${tooltip.day.pnl.toFixed(2)}`
              : `$${tooltip.day.pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          </div>
          <div style={{ color: tooltip.day.roi >= 0 ? 'var(--color-accent-success)' : 'var(--color-accent-error)' }}>
            ROI: {tooltip.day.roi >= 0 ? '+' : ''}{tooltip.day.roi.toFixed(2)}%
          </div>
        </div>
      )}
    </div>
  )
}
