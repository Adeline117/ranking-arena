'use client'

import { useMemo } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

export const CHART_COLORS = [
  tokens.colors.accent.brand,
  'var(--color-enterprise-gradient-start)',
  'var(--color-score-average)',
  'var(--color-score-great)',
  'var(--color-accent-error)',
  '#8b5cf6', // purple
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#84cc16', // lime
]

interface EquityTrader {
  traderId: string
  traderName: string
  data: Array<{ date: string; roi: number }>
  color: string
}

interface EquityCurveOverlayProps {
  traders: EquityTrader[]
  height?: number
}

export default function EquityCurveOverlay({ traders, height = 300 }: EquityCurveOverlayProps) {
  const { t } = useLanguage()
  const tradersWithData = traders.filter(tr => tr.data && tr.data.length > 1)

  const { paths, yLabels, xLabels, yMin, yMax, viewBox } = useMemo(() => {
    if (tradersWithData.length === 0) {
      return { paths: [], yLabels: [], xLabels: [], yMin: 0, yMax: 0, viewBox: '0 0 600 300' }
    }

    const padding = { top: 20, right: 20, bottom: 40, left: 60 }
    const w = 600
    const h = height
    const chartW = w - padding.left - padding.right
    const chartH = h - padding.top - padding.bottom

    // Find global min/max ROI and date range
    let globalMin = Infinity
    let globalMax = -Infinity
    const allDates = new Set<string>()

    for (const trader of tradersWithData) {
      for (const point of trader.data) {
        if (point.roi < globalMin) globalMin = point.roi
        if (point.roi > globalMax) globalMax = point.roi
        allDates.add(point.date)
      }
    }

    // Add padding to range
    const range = globalMax - globalMin || 1
    const yMinVal = globalMin - range * 0.1
    const yMaxVal = globalMax + range * 0.1

    // Sort dates
    const sortedDates = Array.from(allDates).sort()
    const dateToX = new Map<string, number>()
    sortedDates.forEach((date, i) => {
      dateToX.set(date, padding.left + (i / Math.max(sortedDates.length - 1, 1)) * chartW)
    })

    const scaleY = (roi: number) => {
      return padding.top + chartH - ((roi - yMinVal) / (yMaxVal - yMinVal)) * chartH
    }

    // Build paths
    const pathsArr = tradersWithData.map(trader => {
      const sorted = [...trader.data].sort((a, b) => a.date.localeCompare(b.date))
      const points = sorted
        .filter(p => dateToX.has(p.date))
        .map(p => `${dateToX.get(p.date)!.toFixed(1)},${scaleY(p.roi).toFixed(1)}`)

      return {
        d: points.length > 0 ? `M ${points.join(' L ')}` : '',
        color: trader.color,
        name: trader.traderName,
      }
    })

    // Y axis labels (5 ticks)
    const yTicks = 5
    const yLabelArr = Array.from({ length: yTicks + 1 }, (_, i) => {
      const val = yMinVal + (i / yTicks) * (yMaxVal - yMinVal)
      return {
        y: scaleY(val),
        label: `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`,
      }
    })

    // X axis labels (show ~5 dates)
    const xStep = Math.max(1, Math.floor(sortedDates.length / 5))
    const xLabelArr = sortedDates
      .filter((_, i) => i % xStep === 0 || i === sortedDates.length - 1)
      .map(date => ({
        x: dateToX.get(date)!,
        label: date.slice(5), // MM-DD
      }))

    // Zero line
    const zeroY = scaleY(0)

    return {
      paths: pathsArr,
      yLabels: yLabelArr,
      xLabels: xLabelArr,
      yMin: yMinVal,
      yMax: yMaxVal,
      viewBox: `0 0 ${w} ${h}`,
      zeroY: zeroY >= padding.top && zeroY <= padding.top + chartH ? zeroY : null,
    }
  }, [tradersWithData, height])

  if (tradersWithData.length === 0) {
    return (
      <Box style={{
        width: '100%',
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: tokens.colors.bg.secondary,
        borderRadius: tokens.radius.xl,
        border: `1px solid ${tokens.colors.border.primary}`,
      }}>
        <Text size="sm" color="tertiary">{t('noEquityCurveData')}</Text>
      </Box>
    )
  }

  return (
    <Box style={{ width: '100%' }}>
      <svg
        viewBox={viewBox}
        style={{ width: '100%', height: 'auto' }}
        role="img"
        aria-label="Equity curve comparison chart"
      >
        {/* Grid lines */}
        {yLabels.map((tick, i) => (
          <g key={i}>
            <line
              x1={60} y1={tick.y} x2={580} y2={tick.y}
              stroke="var(--color-border-primary, #2a2a3e)"
              strokeWidth={0.5}
              opacity={0.4}
            />
            <text
              x={55} y={tick.y}
              textAnchor="end"
              dominantBaseline="central"
              fontSize={10}
              fill="var(--color-text-tertiary, #6b7280)"
              fontFamily="var(--font-mono, monospace)"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Zero line */}
        {yMin <= 0 && yMax >= 0 && (
          <line
            x1={60} y1={yLabels.find(l => l.label.includes('0.0'))?.y ?? 0}
            x2={580} y2={yLabels.find(l => l.label.includes('0.0'))?.y ?? 0}
            stroke="var(--color-text-tertiary, #6b7280)"
            strokeWidth={1}
            opacity={0.6}
            strokeDasharray="4 4"
          />
        )}

        {/* X axis labels */}
        {xLabels.map((tick, i) => (
          <text
            key={i}
            x={tick.x} y={height - 8}
            textAnchor="middle"
            fontSize={10}
            fill="var(--color-text-tertiary, #6b7280)"
            fontFamily="var(--font-mono, monospace)"
          >
            {tick.label}
          </text>
        ))}

        {/* Equity curves */}
        {paths.map((path, i) => (
          <path
            key={i}
            d={path.d}
            fill="none"
            stroke={path.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.9}
          />
        ))}
      </svg>

      {/* Legend */}
      <Box style={{
        display: 'flex',
        gap: tokens.spacing[3],
        flexWrap: 'wrap',
        justifyContent: 'center',
        marginTop: tokens.spacing[2],
      }}>
        {paths.map((path, i) => (
          <Box key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <Box style={{
              width: 12,
              height: 3,
              borderRadius: 2,
              background: path.color,
              flexShrink: 0,
            }} />
            <Text size="xs" color="secondary" style={{
              maxWidth: 100,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}>
              {path.name}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  )
}
