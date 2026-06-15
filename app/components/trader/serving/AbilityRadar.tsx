'use client'

/**
 * Trading-ability radar (ARENA_REBUILD_SPEC §2.5b). Renders the percentile
 * ability scores adapters capture into `extras.ability_scores` — MEXC exposes
 * { profit, win_rate, win_times, single_max_profit, max_winning_times } as 0-1
 * fractions plus a letter `ability_rating` (S/A+/…). Generic over the axis set:
 * any known key gets a localized label, unknown keys fall back to the raw key,
 * so a future source providing ability_scores lights up for free. Self-
 * contained SVG (same token-driven look as TradingStyleRadar). NULL-collapses.
 */

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '@/app/components/base'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

const CENTER = 70
const RADIUS = 45

/** Known ability-score axis → i18n key. Unknown keys render the raw label. */
const AXIS_I18N: Record<string, string> = {
  profit: 'abilityProfit',
  win_rate: 'abilityWinRate',
  win_times: 'abilityWinTimes',
  single_max_profit: 'abilitySingleMaxProfit',
  max_winning_times: 'abilityMaxWinningTimes',
}

function polarToCartesian(angle: number, r: number): [number, number] {
  const rad = (angle - 90) * (Math.PI / 180)
  return [CENTER + r * Math.cos(rad), CENTER + r * Math.sin(rad)]
}

interface Axis {
  key: string
  /** 0-1 fraction. */
  value: number
}

function parseAxes(extras: Record<string, unknown>): Axis[] {
  const scores = extras.ability_scores as Record<string, unknown> | undefined
  if (!scores || typeof scores !== 'object') return []
  return Object.entries(scores)
    .filter(([, v]) => Number.isFinite(Number(v)))
    .map(([key, v]) => ({ key, value: Math.max(0, Math.min(1, Number(v))) }))
}

export default function AbilityRadar({ extras }: { extras: Record<string, unknown> }) {
  const { t } = useLanguage()
  const axes = parseAxes(extras)
  // A radar needs ≥3 axes to read as an area; below that it's just dots.
  if (axes.length < 3) return null
  if (!axes.some((a) => a.value > 0)) return null

  const rating = typeof extras.ability_rating === 'string' ? extras.ability_rating : null
  const n = axes.length
  const angleStep = 360 / n
  const rings = [0.25, 0.5, 0.75, 1.0]

  const dataPoints = axes.map((a, i) => polarToCartesian(i * angleStep, a.value * RADIUS))
  const dataPath =
    dataPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`).join(' ') + ' Z'

  const labelFor = (key: string) => (AXIS_I18N[key] ? t(AXIS_I18N[key]) : key)

  return (
    <Box>
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: tokens.spacing[2],
          marginBottom: tokens.spacing[2],
        }}
      >
        <Text size="sm" weight="semibold" color="primary">
          {t('abilityRadarTitle')}
        </Text>
        {rating && (
          <Text
            size="xs"
            weight="bold"
            style={{
              padding: `1px ${tokens.spacing[2]}`,
              borderRadius: tokens.radius.full,
              color: 'var(--color-accent-primary)',
              background: 'color-mix(in srgb, var(--color-accent-primary) 14%, transparent)',
            }}
          >
            {rating}
          </Text>
        )}
      </Box>
      <div style={{ width: '100%', maxWidth: 220, margin: '0 auto' }}>
        <svg
          viewBox="0 0 140 140"
          style={{ width: '100%', height: 'auto' }}
          role="img"
          aria-label={t('abilityRadarTitle')}
        >
          {rings.map((level) => {
            const ringPath =
              Array.from({ length: n }, (_, i) => polarToCartesian(i * angleStep, level * RADIUS))
                .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0]},${p[1]}`)
                .join(' ') + ' Z'
            return (
              <path
                key={level}
                d={ringPath}
                fill="none"
                stroke="var(--color-border-primary)"
                strokeWidth="0.5"
                opacity="0.5"
              />
            )
          })}
          {Array.from({ length: n }, (_, i) => {
            const [x, y] = polarToCartesian(i * angleStep, RADIUS)
            return (
              <line
                key={i}
                x1={CENTER}
                y1={CENTER}
                x2={x}
                y2={y}
                stroke="var(--color-border-primary)"
                strokeWidth="0.5"
                opacity="0.3"
              />
            )
          })}
          <path
            d={dataPath}
            fill="var(--color-accent-primary)"
            fillOpacity="0.15"
            stroke="var(--color-accent-primary)"
            strokeWidth="1.5"
          />
          {dataPoints.map((p, i) => (
            <g key={i}>
              <circle cx={p[0]} cy={p[1]} r="2.5" fill="var(--color-accent-primary)" />
              {axes[i].value > 0 && (
                <text
                  x={p[0]}
                  y={p[1] - 5}
                  textAnchor="middle"
                  fontSize="6"
                  fill="var(--color-text-secondary)"
                  fontWeight="600"
                  style={{ fontFamily: tokens.typography.fontFamily.mono.join(', ') }}
                >
                  {Math.round(axes[i].value * 100)}
                </text>
              )}
            </g>
          ))}
          {axes.map((a, i) => {
            const [x, y] = polarToCartesian(i * angleStep, RADIUS + 15)
            return (
              <text
                key={a.key}
                x={x}
                y={y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize="7"
                fontWeight="600"
                fill="var(--color-text-tertiary)"
                style={{ fontFamily: tokens.typography.fontFamily.sans.join(', ') }}
              >
                {labelFor(a.key)}
              </text>
            )
          })}
        </svg>
      </div>
    </Box>
  )
}
