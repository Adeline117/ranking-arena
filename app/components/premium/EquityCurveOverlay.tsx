'use client'

import React, { useEffect, useRef, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

interface EquityPoint {
  date: string
  roi: number
}

interface TraderEquity {
  traderId: string
  traderName: string
  data: EquityPoint[]
  color: string
}

interface EquityCurveOverlayProps {
  traders: TraderEquity[]
  height?: number
}

const CHART_COLORS = [
  '#8b5cf6',
  '#06b6d4',
  '#f59e0b',
  '#ef4444',
  '#10b981',
]

/**
 * Canvas-based equity curve overlay chart.
 * Lightweight alternative when full lightweight-charts is overkill.
 */
export default function EquityCurveOverlay({ traders, height = 280 }: EquityCurveOverlayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const { t } = useLanguage()

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    const width = container.clientWidth
    canvas.width = width * dpr
    canvas.height = height * dpr
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    ctx.scale(dpr, dpr)

    // Clear
    ctx.clearRect(0, 0, width, height)

    if (traders.length === 0 || traders.every(t => t.data.length === 0)) return

    // Calculate bounds
    const padding = { top: 20, right: 20, bottom: 30, left: 55 }
    const chartWidth = width - padding.left - padding.right
    const chartHeight = height - padding.top - padding.bottom

    let allValues: number[] = []
    let maxLen = 0
    for (const trader of traders) {
      if (trader.data.length > maxLen) maxLen = trader.data.length
      for (const p of trader.data) {
        allValues.push(p.roi)
      }
    }

    if (allValues.length === 0 || maxLen === 0) return

    const minVal = Math.min(0, ...allValues)
    const maxVal = Math.max(0, ...allValues)
    const range = maxVal - minVal || 1
    const padRange = range * 0.1

    const yMin = minVal - padRange
    const yMax = maxVal + padRange
    const yRange = yMax - yMin

    // Draw grid lines
    ctx.strokeStyle = tokens.colors.border.primary
    ctx.lineWidth = 0.5
    ctx.globalAlpha = 0.3
    const gridLines = 5
    for (let i = 0; i <= gridLines; i++) {
      const y = padding.top + (i / gridLines) * chartHeight
      ctx.beginPath()
      ctx.moveTo(padding.left, y)
      ctx.lineTo(padding.left + chartWidth, y)
      ctx.stroke()

      // Y axis labels
      const val = yMax - (i / gridLines) * yRange
      ctx.globalAlpha = 0.7
      ctx.fillStyle = tokens.colors.text.tertiary
      ctx.font = '10px -apple-system, sans-serif'
      ctx.textAlign = 'right'
      ctx.fillText(`${val.toFixed(1)}%`, padding.left - 8, y + 3)
      ctx.globalAlpha = 0.3
    }

    // Zero line
    const zeroY = padding.top + ((yMax - 0) / yRange) * chartHeight
    ctx.globalAlpha = 0.5
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    ctx.moveTo(padding.left, zeroY)
    ctx.lineTo(padding.left + chartWidth, zeroY)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.globalAlpha = 1

    // Draw each trader's equity curve
    for (const trader of traders) {
      if (trader.data.length < 2) continue

      const points = trader.data.map((p, i) => ({
        x: padding.left + (i / (maxLen - 1)) * chartWidth,
        y: padding.top + ((yMax - p.roi) / yRange) * chartHeight,
      }))

      // Area fill
      ctx.beginPath()
      ctx.moveTo(points[0].x, zeroY)
      for (const p of points) {
        ctx.lineTo(p.x, p.y)
      }
      ctx.lineTo(points[points.length - 1].x, zeroY)
      ctx.closePath()
      ctx.fillStyle = trader.color
      ctx.globalAlpha = 0.06
      ctx.fill()
      ctx.globalAlpha = 1

      // Line
      ctx.beginPath()
      ctx.moveTo(points[0].x, points[0].y)
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y)
      }
      ctx.strokeStyle = trader.color
      ctx.lineWidth = 2
      ctx.stroke()

      // End dot
      const last = points[points.length - 1]
      ctx.beginPath()
      ctx.arc(last.x, last.y, 3, 0, Math.PI * 2)
      ctx.fillStyle = trader.color
      ctx.fill()
    }

    // X axis labels (first, middle, last dates from longest series)
    const longestTrader = traders.reduce((a, b) => a.data.length >= b.data.length ? a : b)
    if (longestTrader.data.length > 0) {
      ctx.fillStyle = tokens.colors.text.tertiary
      ctx.font = '10px -apple-system, sans-serif'
      ctx.globalAlpha = 0.7
      ctx.textAlign = 'center'

      const indices = [0, Math.floor(longestTrader.data.length / 2), longestTrader.data.length - 1]
      for (const idx of indices) {
        if (idx < longestTrader.data.length) {
          const x = padding.left + (idx / (maxLen - 1)) * chartWidth
          const label = longestTrader.data[idx].date.slice(5) // MM-DD
          ctx.fillText(label, x, height - 8)
        }
      }
    }
  }, [traders, height])

  useEffect(() => {
    draw()
    const handleResize = () => draw()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [draw])

  const hasData = traders.some(t => t.data.length > 0)

  if (!hasData) {
    return (
      <Box
        style={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: tokens.colors.bg.tertiary,
          borderRadius: tokens.radius.lg,
        }}
      >
        <Text size="sm" color="tertiary">{t('compareNoEquityData')}</Text>
      </Box>
    )
  }

  return (
    <div style={{ position: 'relative' }}>
      <div ref={containerRef} style={{ width: '100%' }}>
        <canvas ref={canvasRef} style={{ display: 'block', borderRadius: tokens.radius.lg }} />
      </div>
      {/* Legend */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, justifyContent: 'center', marginTop: 12 }}>
        {traders.map((trader, i) => (
          <div key={trader.traderId} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div
              style={{
                width: 12,
                height: 3,
                borderRadius: 2,
                background: trader.color,
              }}
            />
            <span style={{ fontSize: 12, color: tokens.colors.text.secondary }}>
              {trader.traderName}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

export { CHART_COLORS }
