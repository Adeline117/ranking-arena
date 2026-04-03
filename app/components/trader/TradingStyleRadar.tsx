'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '../Providers/LanguageProvider'

interface TradingStyleRadarProps {
  profitability?: number | null  // 0-100
  riskControl?: number | null    // 0-100
  execution?: number | null      // 0-100
  winRate?: number | null         // 0-100
  maxDrawdown?: number | null     // raw %, will be inverted
  consistency?: number | null     // 0-100 (sharpe normalized)
}

const AXES = 5
const CENTER = 70
const RADIUS = 45

function polarToCartesian(angle: number, r: number): [number, number] {
  const rad = (angle - 90) * (Math.PI / 180)
  return [CENTER + r * Math.cos(rad), CENTER + r * Math.sin(rad)]
}

export default function TradingStyleRadar({
  profitability,
  riskControl,
  execution,
  winRate,
  maxDrawdown,
}: TradingStyleRadarProps) {
  const { t, language: _language } = useLanguage()

  // Normalize values to 0-1
  const normalize = (v: number | null | undefined, max: number = 100) => {
    if (v == null) return 0
    return Math.min(1, Math.max(0, v / max))
  }

  const values = [
    normalize(profitability),
    normalize(riskControl),
    normalize(execution),
    normalize(winRate),
    maxDrawdown != null ? Math.max(0, Math.min(1, 1 - Math.abs(maxDrawdown) / 100)) : 0, // Lower MDD = higher score; scale 0-100%
  ]

  const labels = [t('radarProfit'), t('radarRisk'), t('radarExec'), t('radarWinRate'), t('radarStable')]

  // Check if we have any data
  const hasData = values.some(v => v > 0)
  if (!hasData) return null

  const angleStep = 360 / AXES

  // Generate polygon points for each ring level
  const rings = [0.2, 0.4, 0.6, 0.8, 1.0]

  // Data polygon
  const dataPoints = values.map((v, i) => {
    const angle = i * angleStep
    return polarToCartesian(angle, v * RADIUS)
  })
  const dataPath = dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`).join(' ') + ' Z'

  return (
    <div style={{ width: '100%', maxWidth: 200, margin: '0 auto' }}>
      <svg viewBox="0 0 140 140" style={{ width: '100%', height: 'auto' }} role="img" aria-label={t('traderTradingStyleLabel')}>
        {/* Ring guides */}
        {rings.map((level) => {
          const ringPoints = Array.from({ length: AXES }, (_, i) => {
            const angle = i * angleStep
            return polarToCartesian(angle, level * RADIUS)
          })
          const ringPath = ringPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`).join(' ') + ' Z'
          return <path key={level} d={ringPath} fill="none" stroke="var(--color-border-primary)" strokeWidth="0.5" opacity="0.5" />
        })}

        {/* Axis lines */}
        {Array.from({ length: AXES }, (_, i) => {
          const angle = i * angleStep
          const [x, y] = polarToCartesian(angle, RADIUS)
          return <line key={i} x1={CENTER} y1={CENTER} x2={x} y2={y} stroke="var(--color-border-primary)" strokeWidth="0.5" opacity="0.3" />
        })}

        {/* Pattern for colorblind accessibility */}
        <defs>
          <pattern id="radar-hatch" patternUnits="userSpaceOnUse" width="4" height="4" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="4" stroke="var(--color-accent-primary)" strokeWidth="0.5" opacity="0.3" />
          </pattern>
        </defs>

        {/* Data fill with pattern overlay */}
        <path d={dataPath} fill="var(--color-accent-primary)" fillOpacity="0.15" stroke="var(--color-accent-primary)" strokeWidth="1.5" />
        <path d={dataPath} fill="url(#radar-hatch)" />

        {/* Data dots with value labels */}
        {dataPoints.map((p, i) => (
          <g key={i}>
            <circle cx={p[0]} cy={p[1]} r="2.5" fill="var(--color-accent-primary)" />
            {values[i] > 0 && (
              <text x={p[0]} y={p[1] - 5} textAnchor="middle" fontSize="6" fill="var(--color-text-secondary)" fontWeight="600"
                style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}>
                {Math.round(values[i] * 100)}
              </text>
            )}
          </g>
        ))}

        {/* Labels */}
        {labels.map((label, i) => {
          const angle = i * angleStep
          const [x, y] = polarToCartesian(angle, RADIUS + 14)
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize="8"
              fontWeight="600"
              fill="var(--color-text-tertiary)"
              style={{ fontFamily: tokens.typography.fontFamily.sans.join(', ') }}
            >
              {label}
            </text>
          )
        })}
      </svg>
    </div>
  )
}
