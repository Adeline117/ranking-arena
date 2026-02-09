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

  // Mini semi-circle gauge
  const cx = 32, cy = 28, r = 22
  const startAngle = Math.PI
  const endAngle = 0
  const angleRange = startAngle - endAngle
  const needleAngle = startAngle - (value / 100) * angleRange
  const nx = cx + (r - 3) * Math.cos(needleAngle)
  const ny = cy - (r - 3) * Math.sin(needleAngle)

  const segments = [
    { from: 0, to: 0.25, color: '#ea3943' },
    { from: 0.25, to: 0.5, color: '#ea8c00' },
    { from: 0.5, to: 0.75, color: '#93d900' },
    { from: 0.75, to: 1, color: '#16c784' },
  ]

  const arc = (start: number, end: number, radius: number) => {
    const x1 = cx + radius * Math.cos(start)
    const y1 = cy - radius * Math.sin(start)
    const x2 = cx + radius * Math.cos(end)
    const y2 = cy - radius * Math.sin(end)
    return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`
  }

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
      <div style={{ fontSize: 10, color: tokens.colors.text.tertiary, fontWeight: 500, textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
        {t('fearGreedTitle')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <svg width="64" height="34" viewBox="0 0 64 34">
          {segments.map((seg, i) => {
            const a1 = startAngle - seg.from * angleRange
            const a2 = startAngle - seg.to * angleRange
            return <path key={i} d={arc(a1, a2, r)} fill="none" stroke={seg.color} strokeWidth="5" strokeLinecap="round" opacity={0.3} />
          })}
          <path d={arc(startAngle, needleAngle, r)} fill="none" stroke={color} strokeWidth="5" strokeLinecap="round" />
          <circle cx={nx} cy={ny} r="3" fill={color} />
          <circle cx={nx} cy={ny} r="1.5" fill={tokens.colors.bg.primary} />
        </svg>
        <div>
          <div style={{ fontSize: 20, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
          <div style={{ fontSize: 10, fontWeight: 600, color, lineHeight: 1.3 }}>{label}</div>
        </div>
      </div>
    </div>
  )
}
