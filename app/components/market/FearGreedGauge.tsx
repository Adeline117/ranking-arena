'use client'

import { useEffect, useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { FearGreedData } from '@/lib/utils/fear-greed'

function getColor(value: number): string {
  if (value <= 25) return '#ea3943'
  if (value <= 46) return '#ea8c00'
  if (value <= 54) return '#f5c623'
  if (value <= 75) return '#93d900'
  return '#16c784'
}

function getLabel(value: number): string {
  if (value <= 25) return t('fearGreedExtremeFear')
  if (value <= 46) return t('fearGreedFear')
  if (value <= 54) return t('fearGreedNeutral')
  if (value <= 75) return t('fearGreedGreed')
  return t('fearGreedExtremeGreed')
}

// SVG arc path helper
function describeArc(cx: number, cy: number, r: number, startDeg: number, endDeg: number): string {
  const toRad = (d: number) => (d * Math.PI) / 180
  const x1 = cx + r * Math.cos(toRad(startDeg))
  const y1 = cy + r * Math.sin(toRad(startDeg))
  const x2 = cx + r * Math.cos(toRad(endDeg))
  const y2 = cy + r * Math.sin(toRad(endDeg))
  const large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

export default function FearGreedGauge() {
  const [data, setData] = useState<FearGreedData | null>(null)

  useEffect(() => {
    fetch('/api/market/fear-greed')
      .then((r) => r.json())
      .then((json) => { if (json.current) setData(json.current) })
      .catch(() => {})
  }, [])

  if (!data) {
    return (
      <div style={{
        padding: '10px 12px',
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        borderRadius: tokens.radius.md,
        border: tokens.glass.border.light,
        height: 80,
      }}>
        <div className="skeleton" style={{ height: '100%', borderRadius: 6 }} />
      </div>
    )
  }

  const value = data.value
  const color = getColor(value)
  const label = getLabel(value)

  // Gauge geometry: semi-circle from 180deg to 0deg (left to right)
  const cx = 50, cy = 44, r = 34, strokeW = 7
  // Color segments: Extreme Fear(red) -> Fear(orange) -> Neutral(yellow) -> Greed(green) -> Extreme Greed(teal)
  const segments = [
    { from: 180, to: 144, color: '#ea3943' },
    { from: 144, to: 108, color: '#ea8c00' },
    { from: 108, to: 72, color: '#f5c623' },
    { from: 72, to: 36, color: '#93d900' },
    { from: 36, to: 0, color: '#16c784' },
  ]

  // Needle angle: 180 (value=0) to 0 (value=100)
  const needleDeg = 180 - (value / 100) * 180
  const needleRad = (needleDeg * Math.PI) / 180
  const needleLen = r - 6
  const nx = cx + needleLen * Math.cos(needleRad)
  const ny = cy - needleLen * Math.sin(needleRad)

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 2 }}>
        {t('fearGreedTitle')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <svg width="80" height="48" viewBox="0 0 100 52" style={{ flexShrink: 0 }}>
          {/* Background segments */}
          {segments.map((seg, i) => (
            <path
              key={i}
              d={describeArc(cx, cy, r, seg.from, seg.to)}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeW}
              strokeLinecap="butt"
              opacity={0.25}
            />
          ))}
          {/* Active arc up to current value */}
          {segments.map((seg, i) => {
            // Only draw segments that the value has reached
            const segStart = ((180 - seg.from) / 180) * 100
            const segEnd = ((180 - seg.to) / 180) * 100
            if (value <= segStart) return null
            const clampedEnd = Math.min(value, segEnd)
            const drawFrom = 180 - (Math.max(segStart, 0) / 100) * 180
            const drawTo = 180 - (clampedEnd / 100) * 180
            if (drawFrom <= drawTo) return null
            return (
              <path
                key={`active-${i}`}
                d={describeArc(cx, cy, r, drawFrom, drawTo)}
                fill="none"
                stroke={seg.color}
                strokeWidth={strokeW}
                strokeLinecap="butt"
              />
            )
          })}
          {/* Needle */}
          <line x1={cx} y1={cy} x2={nx} y2={ny} stroke={color} strokeWidth="2" strokeLinecap="round" />
          <circle cx={cx} cy={cy} r="3" fill={color} />
          <circle cx={cx} cy={cy} r="1.5" fill={tokens.colors.bg.primary} />
        </svg>
        <div>
          <div style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color, lineHeight: 1.4, whiteSpace: 'nowrap' }}>{label}</div>
        </div>
      </div>
    </div>
  )
}
