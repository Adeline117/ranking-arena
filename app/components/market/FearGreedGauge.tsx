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
        padding: '10px 12px',
        background: tokens.glass.bg.secondary,
        backdropFilter: tokens.glass.blur.md,
        borderRadius: tokens.radius.md,
        border: tokens.glass.border.light,
        height: 64,
      }}>
        <div className="skeleton" style={{ height: '100%', borderRadius: 6 }} />
      </div>
    )
  }

  const value = data.value
  const color = getColor(value)
  const label = getLabel(value)

  return (
    <div style={{
      padding: '10px 12px',
      background: tokens.glass.bg.secondary,
      backdropFilter: tokens.glass.blur.md,
      borderRadius: tokens.radius.md,
      border: tokens.glass.border.light,
    }}>
      <div style={{
        fontSize: 10,
        color: tokens.colors.text.tertiary,
        fontWeight: 500,
        marginBottom: 6,
        textTransform: 'uppercase',
        letterSpacing: '0.5px',
      }}>
        {t('fearGreedTitle')}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 22, fontWeight: 800, color, lineHeight: 1 }}>{value}</span>
        <span style={{ fontSize: 11, fontWeight: 600, color, lineHeight: 1 }}>{label}</span>
      </div>
    </div>
  )
}
