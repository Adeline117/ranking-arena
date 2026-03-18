'use client'

import { useEffect, useState, useRef, useMemo, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

interface HistoryDataPoint {
  date: string
  roi: number
  pnl: number | null
  rank: number | null
  arenaScore: number | null
  winRate: number | null
  maxDrawdown: number | null
}

interface RankTrendSparklineProps {
  platform: string
  traderKey: string
  width?: number
  height?: number
}

export default function RankTrendSparkline({
  platform,
  traderKey,
  width = 120,
  height = 32,
}: RankTrendSparklineProps) {
  const { t } = useLanguage()
  const [data, setData] = useState<HistoryDataPoint[] | null>(null)
  const [tooltip, setTooltip] = useState<{ x: number; point: HistoryDataPoint } | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)

  useEffect(() => {
    if (!platform || !traderKey) return
    let cancelled = false

    const fetchHistory = async () => {
      try {
        const res = await fetch(
          `/api/trader/${encodeURIComponent(platform)}/${encodeURIComponent(traderKey)}/history?period=30D`
        )
        if (!res.ok) return
        const json = await res.json()
        if (!cancelled && json.history?.['30D']) {
          setData(json.history['30D'])
        }
      } catch {
        // Silently fail -- sparkline is non-critical
      }
    }

    fetchHistory()
    return () => { cancelled = true }
  }, [platform, traderKey])

  const points = useMemo(() => {
    if (!data) return []
    return data.filter(d => d.arenaScore != null && d.arenaScore > 0)
  }, [data])

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (!svgRef.current || points.length < 2) return
      const rect = svgRef.current.getBoundingClientRect()
      const x = e.clientX - rect.left
      const idx = Math.round((x / width) * (points.length - 1))
      const clamped = Math.max(0, Math.min(idx, points.length - 1))
      setTooltip({ x: (clamped / (points.length - 1)) * width, point: points[clamped] })
    },
    [points, width],
  )

  const handleMouseLeave = useCallback(() => setTooltip(null), [])

  // Touch support for mobile
  const handleTouchMove = useCallback(
    (e: React.TouchEvent<SVGSVGElement>) => {
      if (!svgRef.current || points.length < 2) return
      const rect = svgRef.current.getBoundingClientRect()
      const touch = e.touches[0]
      const x = touch.clientX - rect.left
      const idx = Math.round((x / width) * (points.length - 1))
      const clamped = Math.max(0, Math.min(idx, points.length - 1))
      setTooltip({ x: (clamped / (points.length - 1)) * width, point: points[clamped] })
    },
    [points, width],
  )
  const handleTouchEnd = useCallback(() => setTooltip(null), [])

  if (!points || points.length < 2) return null

  const scores = points.map(p => p.arenaScore as number)
  const minScore = Math.min(...scores)
  const maxScore = Math.max(...scores)
  const range = maxScore - minScore || 1
  const padding = 2

  const pathPoints = points.map((p, i) => {
    const x = (i / (points.length - 1)) * width
    const y = padding + (1 - ((p.arenaScore as number) - minScore) / range) * (height - padding * 2)
    return `${x},${y}`
  })
  const pathD = `M${pathPoints.join(' L')}`
  const areaD = `${pathD} L${width},${height} L0,${height} Z`

  const first = scores[0]
  const last = scores[scores.length - 1]
  const isUp = last >= first
  const strokeColor = isUp
    ? 'var(--color-accent-success, #10b981)'
    : 'var(--color-accent-error, #ef4444)'
  const gradientId = `sparkline-grad-${platform}-${traderKey}`.replace(/[^a-zA-Z0-9-]/g, '_')

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, position: 'relative' }}
      title={t('rankTrendTooltip')}>
      <svg ref={svgRef} width={width} height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ cursor: 'crosshair', overflow: 'visible' }}
        onMouseMove={handleMouseMove} onMouseLeave={handleMouseLeave}
        onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={strokeColor} stopOpacity={0.25} />
            <stop offset="100%" stopColor={strokeColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path d={areaD} fill={`url(#${gradientId})`} />
        <path d={pathD} fill="none" stroke={strokeColor} strokeWidth={1.5}
          strokeLinecap="round" strokeLinejoin="round" />
        {(() => {
          const lastX = width
          const lastY = padding + (1 - (last - minScore) / range) * (height - padding * 2)
          return <circle cx={lastX} cy={lastY} r={2.5} fill={strokeColor}
            stroke="var(--color-bg-primary, #0f0f23)" strokeWidth={1} />
        })()}
        {tooltip && (
          <>
            <line x1={tooltip.x} y1={0} x2={tooltip.x} y2={height}
              stroke={tokens.colors.text.tertiary} strokeWidth={0.5}
              strokeDasharray="2,2" opacity={0.5} />
            <circle cx={tooltip.x}
              cy={padding + (1 - ((tooltip.point.arenaScore as number) - minScore) / range) * (height - padding * 2)}
              r={3} fill={strokeColor} stroke="var(--color-bg-primary, #0f0f23)" strokeWidth={1.5} />
          </>
        )}
      </svg>
      {tooltip && (
        <div style={{
          position: 'absolute', bottom: height + 6,
          left: Math.max(0, Math.min(tooltip.x - 50, width - 100)),
          background: tokens.glass.bg.heavy,
          backdropFilter: tokens.glass.blur.md,
          WebkitBackdropFilter: tokens.glass.blur.md,
          border: tokens.glass.border.medium,
          borderRadius: tokens.radius.md,
          padding: '4px 8px', pointerEvents: 'none', zIndex: 10, whiteSpace: 'nowrap', minWidth: 90,
        }}>
          <div style={{ fontSize: 10, color: tokens.colors.text.tertiary }}>{tooltip.point.date}</div>
          <div style={{ fontSize: 11, fontWeight: 700, color: tokens.colors.text.primary,
            fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
            Score: {(tooltip.point.arenaScore as number).toFixed(1)}
          </div>
          {tooltip.point.rank != null && (
            <div style={{ fontSize: 10, color: tokens.colors.text.secondary }}>
              {t('rank')}: #{tooltip.point.rank}
            </div>
          )}
        </div>
      )}
      <span style={{ fontSize: 11, fontWeight: 600, color: strokeColor,
        fontFamily: tokens.typography.fontFamily.mono.join(', '), letterSpacing: '-0.02em' }}>
        {isUp ? '+' : ''}{(last - first).toFixed(1)}
      </span>
    </div>
  )
}
