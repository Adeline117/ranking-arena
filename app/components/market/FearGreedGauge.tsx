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

export default function FearGreedGauge() {
  const [data, setData] = useState<FearGreedData | null>(null)

  useEffect(() => {
    fetch('/api/market/fear-greed')
      .then((r) => r.json())
      .then((json) => {
        if (json.current) setData(json.current)
      })
      .catch(() => {})
  }, [])

  if (!data) {
    return (
      <div style={{
        padding: tokens.spacing[4],
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        borderRadius: tokens.radius.lg,
        border: tokens.glass.border.light,
        height: 120,
      }}>
        <div className="skeleton" style={{ height: '100%', borderRadius: 8 }} />
      </div>
    )
  }

  const value = data.value
  const color = getColor(value)
  const label = getLabel(value)

  // SVG semi-circle gauge
  const cx = 80
  const cy = 72
  const r = 60
  // Arc from 180° to 0° (left to right, semi-circle)
  const startAngle = Math.PI
  const endAngle = 0
  const angleRange = startAngle - endAngle
  const needleAngle = startAngle - (value / 100) * angleRange

  // Arc path helper
  const arc = (start: number, end: number, radius: number) => {
    const x1 = cx + radius * Math.cos(start)
    const y1 = cy - radius * Math.sin(start)
    const x2 = cx + radius * Math.cos(end)
    const y2 = cy - radius * Math.sin(end)
    const largeArc = Math.abs(start - end) > Math.PI ? 1 : 0
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`
  }

  // Color stops for the arc background
  const segments = [
    { from: 0, to: 0.25, color: '#ea3943' },
    { from: 0.25, to: 0.46, color: '#ea8c00' },
    { from: 0.46, to: 0.54, color: '#f5c623' },
    { from: 0.54, to: 0.75, color: '#93d900' },
    { from: 0.75, to: 1, color: '#16c784' },
  ]

  const needleX = cx + (r - 8) * Math.cos(needleAngle)
  const needleY = cy - (r - 8) * Math.sin(needleAngle)

  return (
    <div style={{
      padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.lg,
      border: tokens.glass.border.light,
    }}>
      <div style={{
        fontSize: tokens.typography.fontSize.xs,
        color: tokens.colors.text.secondary,
        fontWeight: tokens.typography.fontWeight.medium,
        marginBottom: tokens.spacing[1],
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        {t('fearGreedTitle')}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <svg width="160" height="88" viewBox="0 0 160 88">
          {/* Background arc segments */}
          {segments.map((seg, i) => {
            const a1 = startAngle - seg.from * angleRange
            const a2 = startAngle - seg.to * angleRange
            return (
              <path
                key={i}
                d={arc(a1, a2, r)}
                fill="none"
                stroke={seg.color}
                strokeWidth="10"
                strokeLinecap="round"
                opacity={0.25}
              />
            )
          })}

          {/* Active arc up to current value */}
          <path
            d={arc(startAngle, needleAngle, r)}
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
          />

          {/* Needle dot */}
          <circle cx={needleX} cy={needleY} r="5" fill={color} />
          <circle cx={needleX} cy={needleY} r="2.5" fill={tokens.colors.bg.primary} />

          {/* Center value */}
          <text
            x={cx}
            y={cy - 8}
            textAnchor="middle"
            fill={color}
            fontSize="28"
            fontWeight="700"
            fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
          >
            {value}
          </text>
          <text
            x={cx}
            y={cy + 10}
            textAnchor="middle"
            fill="currentColor"
            fontSize="11"
            fontWeight="500"
            opacity={0.7}
            fontFamily="-apple-system, BlinkMacSystemFont, sans-serif"
          >
            {label}
          </text>
        </svg>
      </div>
    </div>
  )
}
