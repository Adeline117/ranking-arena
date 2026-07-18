'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { getLocaleFromLanguage } from '@/lib/utils/format'
import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import type { FearGreedData } from '@/lib/utils/fear-greed'
import { apiFetch } from '@/lib/utils/api-fetch'
import Sparkline from '@/app/components/ui/Sparkline'
import ErrorState from '@/app/components/ui/ErrorState'

function getColor(value: number): string {
  if (value <= 25) return tokens.colors.gauge.extremeFear
  if (value <= 46) return tokens.colors.gauge.fear
  if (value <= 54) return tokens.colors.gauge.neutral
  if (value <= 75) return tokens.colors.gauge.greed
  return tokens.colors.gauge.extremeGreed
}

export default function FearGreedGauge() {
  const { t, language } = useLanguage()
  const [data, setData] = useState<FearGreedData | null>(null)
  const [history, setHistory] = useState<number[]>([])
  const [animatedValue, setAnimatedValue] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const prevValueRef = useRef(0)

  function getLabel(value: number): string {
    if (value <= 25) return t('fearGreedExtremeFear')
    if (value <= 46) return t('fearGreedFear')
    if (value <= 54) return t('fearGreedNeutral')
    if (value <= 75) return t('fearGreedGreed')
    return t('fearGreedExtremeGreed')
  }

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const json = await apiFetch<{ current?: FearGreedData; history?: FearGreedData[] }>(
        '/api/market/fear-greed'
      )
      if (!json.current) {
        // A successful empty upstream response is not a network failure.
        setData(null)
        setHistory([])
        return
      }

      // Stale sentiment is unsafe to present as current market context. Keep it
      // out of the gauge, but expose the failure and an explicit retry.
      const ts = Number(json.current.timestamp) * 1000
      if (!Number.isFinite(ts) || Date.now() - ts > 24 * 60 * 60 * 1000) {
        setData(null)
        setHistory([])
        setError('stale')
        return
      }

      setData(json.current)
      // API returns history most-recent-first; reverse for chronological
      // (oldest → newest) so the sparkline reads left-to-right.
      setHistory(
        Array.isArray(json.history) && json.history.length > 1
          ? json.history
              .map((d) => Number(d.value))
              .filter((v) => Number.isFinite(v))
              .reverse()
          : []
      )
    } catch (err) {
      setData(null)
      setHistory([])
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!data) return
    const prefersReduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches
    const from = prevValueRef.current
    const to = data.value

    if (prefersReduced) {
      setAnimatedValue(to)
      prevValueRef.current = to
      return
    }

    const duration = 1200
    const startTime = performance.now()

    function animate(now: number) {
      const elapsed = now - startTime
      const progress = Math.min(elapsed / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setAnimatedValue(from + (to - from) * eased)
      if (progress < 1) requestAnimationFrame(animate)
      else prevValueRef.current = to
    }
    requestAnimationFrame(animate)
  }, [data?.value]) // eslint-disable-line react-hooks/exhaustive-deps -- animate only on value change; prevValueRef is a stable ref

  const cardStyle = {
    padding: tokens.spacing[5],
    background: tokens.glass.bg.medium,
    backdropFilter: tokens.glass.blur.lg,
    borderRadius: tokens.radius.xl,
    border: tokens.glass.border.light,
    height: '100%',
  }

  if (loading && !data) {
    return (
      <div style={cardStyle}>
        <div className="skeleton" style={{ height: '100%', borderRadius: tokens.radius.lg }} />
      </div>
    )
  }

  if (error && !data) {
    return (
      <div style={cardStyle}>
        <ErrorState
          title={t('marketDataError')}
          description={t('loadFailedRetryShort')}
          retry={() => void load()}
          variant="compact"
        />
      </div>
    )
  }

  if (!data) {
    return (
      <div
        role="status"
        style={{
          ...cardStyle,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.colors.text.tertiary,
          fontSize: tokens.typography.fontSize.sm,
        }}
      >
        {t('noDataGeneric')}
      </div>
    )
  }

  const displayValue = Math.max(0, Math.min(100, data.value ?? 0))
  const color = getColor(displayValue)
  const label = getLabel(displayValue)

  // Dashboard arc geometry
  const cx = 120,
    cy = 95,
    r = 70
  const startAngle = 135 // bottom-left
  const endAngle = 405 // bottom-right (135 + 270)
  const totalArc = endAngle - startAngle // 270 degrees

  // Progress angle
  const progressAngle = startAngle + (animatedValue / 100) * totalArc

  // Arc path helper
  const toRad = (d: number) => (d * Math.PI) / 180
  const arcPath = (from: number, to: number, radius: number) => {
    const x1 = cx + radius * Math.cos(toRad(from))
    const y1 = cy + radius * Math.sin(toRad(from))
    const x2 = cx + radius * Math.cos(toRad(to))
    const y2 = cy + radius * Math.sin(toRad(to))
    const sweep = to - from > 180 ? 1 : 0
    return `M ${x1} ${y1} A ${radius} ${radius} 0 ${sweep} 1 ${x2} ${y2}`
  }

  // Gradient stops for the arc
  const gradientSegments = [
    { from: 0, to: 0.25, color: '#ea3943' },
    { from: 0.25, to: 0.46, color: '#ea8c00' },
    { from: 0.46, to: 0.54, color: '#f5c623' },
    { from: 0.54, to: 0.75, color: '#93d900' },
    { from: 0.75, to: 1.0, color: '#16c784' },
  ]

  // Tick marks
  const ticks = [0, 25, 50, 75, 100]

  // Needle endpoint
  const needleAngle = toRad(progressAngle)
  const needleLen = r - 16
  const nx = cx + needleLen * Math.cos(needleAngle)
  const ny = cy + needleLen * Math.sin(needleAngle)

  return (
    <div
      style={{
        ...cardStyle,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: tokens.gradient.purple,
          opacity: 0.6,
        }}
      />

      {/* Title */}
      <div
        style={{
          fontSize: tokens.typography.fontSize.base,
          fontWeight: 700,
          color: tokens.colors.text.primary,
          marginBottom: tokens.spacing[2],
          letterSpacing: '0.3px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span>{t('fearGreedTitle')}</span>
        {data.timestamp && (
          <span
            style={{
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
              fontWeight: 400,
            }}
          >
            {new Date(Number(data.timestamp) * 1000).toLocaleDateString(
              getLocaleFromLanguage(language)
            )}
          </span>
        )}
      </div>

      {/* Dashboard Gauge */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="240" height="150" viewBox="0 0 240 150" style={{ overflow: 'visible' }}>
          <defs>
            <linearGradient id="fgGradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="#ea3943" />
              <stop offset="25%" stopColor="#ea8c00" />
              <stop offset="50%" stopColor="#f5c623" />
              <stop offset="75%" stopColor="#93d900" />
              <stop offset="100%" stopColor="#16c784" />
            </linearGradient>
            <filter id="fgGlow">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="fgNeedleGlow">
              <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor={color} floodOpacity="0.6" />
            </filter>
          </defs>

          {/* Background track */}
          <path
            d={arcPath(startAngle, endAngle, r)}
            fill="none"
            stroke="var(--glass-border-light, rgba(255,255,255,0.08))"
            strokeWidth="12"
            strokeLinecap="round"
          />

          {/* Colored segments (background, dim) */}
          {gradientSegments.map((seg, i) => {
            const segFrom = startAngle + seg.from * totalArc
            const segTo = startAngle + seg.to * totalArc
            return (
              <path
                key={i}
                d={arcPath(segFrom, segTo, r)}
                fill="none"
                stroke={seg.color}
                strokeWidth="12"
                strokeLinecap="butt"
                opacity={0.15}
              />
            )
          })}

          {/* Active arc (filled up to current value) */}
          {animatedValue > 0 &&
            gradientSegments.map((seg, i) => {
              const segFrom = startAngle + seg.from * totalArc
              const segTo = startAngle + seg.to * totalArc
              if (progressAngle <= segFrom) return null
              const clampedTo = Math.min(progressAngle, segTo)
              if (segFrom >= clampedTo) return null
              return (
                <path
                  key={`active-${i}`}
                  d={arcPath(segFrom, clampedTo, r)}
                  fill="none"
                  stroke={seg.color}
                  strokeWidth="12"
                  strokeLinecap={i === 0 ? 'round' : 'butt'}
                  filter="url(#fgGlow)"
                />
              )
            })}

          {/* Tick marks + labels */}
          {ticks.map((val) => {
            const angle = toRad(startAngle + (val / 100) * totalArc)
            const innerR = r - 8
            const outerR = r + 8
            const labelR = r + 18
            const x1 = cx + innerR * Math.cos(angle)
            const y1 = cy + innerR * Math.sin(angle)
            const x2 = cx + outerR * Math.cos(angle)
            const y2 = cy + outerR * Math.sin(angle)
            const lx = cx + labelR * Math.cos(angle)
            const ly = cy + labelR * Math.sin(angle)
            return (
              <g key={val}>
                <line
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="var(--color-text-tertiary, #666)"
                  strokeWidth="1.5"
                  opacity={0.4}
                />
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="var(--color-text-tertiary, #666)"
                  fontSize="10"
                  fontWeight="500"
                >
                  {val}
                </text>
              </g>
            )
          })}

          {/* Needle */}
          <line
            x1={cx}
            y1={cy}
            x2={nx}
            y2={ny}
            stroke={color}
            strokeWidth="2.5"
            strokeLinecap="round"
            filter="url(#fgNeedleGlow)"
          />
          {/* Needle hub */}
          <circle
            cx={cx}
            cy={cy}
            r="8"
            fill="var(--color-bg-primary, #1a1a2e)"
            stroke={color}
            strokeWidth="2.5"
          />
          <circle cx={cx} cy={cy} r="3" fill={color} />

          {/* Center value */}
          <text
            x={cx}
            y={cy + 24}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={color}
            fontSize="28"
            fontWeight="800"
            fontFamily="var(--font-mono, monospace)"
            letterSpacing="-1.5"
            style={{ fontVariantNumeric: 'tabular-nums' } as React.CSSProperties}
          >
            {displayValue}
          </text>

          {/* Label below value */}
          <text
            x={cx}
            y={cy + 42}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={color}
            fontSize="11"
            fontWeight="600"
            letterSpacing="1"
            textDecoration="none"
            opacity="0.85"
          >
            {label}
          </text>
        </svg>

        {/* 30-day history sparkline — adds trend context to the single value */}
        {history.length > 1 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: tokens.spacing[2],
              marginTop: tokens.spacing[1],
            }}
          >
            <span
              style={{
                fontSize: tokens.typography.fontSize.xs,
                color: tokens.colors.text.tertiary,
                fontWeight: tokens.typography.fontWeight.medium,
              }}
            >
              {t('days30')}
            </span>
            <Sparkline
              data={history}
              color={color}
              width={120}
              height={28}
              ariaLabel={`${t('fearGreedTitle')} ${t('days30')}`}
            />
          </div>
        )}
      </div>
    </div>
  )
}
