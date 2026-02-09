'use client'

import { useEffect, useState, useRef } from 'react'
import { tokens } from '@/lib/design-tokens'
import { t } from '@/lib/i18n'
import type { FearGreedData } from '@/lib/utils/fear-greed'

function getColor(value: number): string {
  if (value <= 25) return 'var(--color-accent-error)'
  if (value <= 46) return 'var(--color-score-average)'
  if (value <= 54) return 'var(--color-accent-warning)'
  if (value <= 75) return 'var(--color-accent-success)'
  return 'var(--color-accent-success)'
}

function getLabel(value: number): string {
  if (value <= 25) return t('fearGreedExtremeFear')
  if (value <= 46) return t('fearGreedFear')
  if (value <= 54) return t('fearGreedNeutral')
  if (value <= 75) return t('fearGreedGreed')
  return t('fearGreedExtremeGreed')
}

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
  const [animatedValue, setAnimatedValue] = useState(0)
  const prevValueRef = useRef(0)

  useEffect(() => {
    fetch('/api/market/fear-greed')
      .then((r) => r.json())
      .then((json) => { if (json.current) setData(json.current) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!data) return
    const from = prevValueRef.current
    const to = data.value
    const duration = 1000
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
  }, [data?.value]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) {
    return (
      <div style={{
        padding: tokens.spacing[5],
        background: tokens.glass.bg.medium,
        backdropFilter: tokens.glass.blur.lg,
        borderRadius: tokens.radius.xl,
        border: tokens.glass.border.light,
        height: '100%',
      }}>
        <div className="skeleton" style={{ height: '100%', borderRadius: tokens.radius.lg }} />
      </div>
    )
  }

  const value = animatedValue
  const displayValue = data.value
  const color = getColor(displayValue)
  const label = getLabel(displayValue)

  // Gauge geometry - larger semi-circle
  const cx = 100, cy = 88, r = 70, strokeW = 14
  const segments = [
    { from: 180, to: 144, color: 'var(--color-accent-error)' },
    { from: 144, to: 108, color: 'var(--color-score-average)' },
    { from: 108, to: 72, color: 'var(--color-accent-warning)' },
    { from: 72, to: 36, color: 'var(--color-accent-success)' },
    { from: 36, to: 0, color: 'var(--color-accent-success)' },
  ]

  // Needle
  const needleDeg = 180 - (value / 100) * 180
  const needleRad = (needleDeg * Math.PI) / 180
  const needleLen = r - 12
  const nx = cx + needleLen * Math.cos(needleRad)
  const ny = cy - needleLen * Math.sin(needleRad)

  // Scale labels positions
  const scaleLabels = [
    { val: 0, deg: 180, text: '0' },
    { val: 25, deg: 135, text: '25' },
    { val: 50, deg: 90, text: '50' },
    { val: 75, deg: 45, text: '75' },
    { val: 100, deg: 0, text: '100' },
  ]

  return (
    <div style={{
      padding: tokens.spacing[5],
      background: tokens.glass.bg.medium,
      backdropFilter: tokens.glass.blur.lg,
      borderRadius: tokens.radius.xl,
      border: tokens.glass.border.light,
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Top accent line */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 2,
        background: `linear-gradient(90deg, #ea3943, #ea8c00, #f5c623, #93d900, #16c784)`,
        opacity: 0.6,
      }} />

      {/* Title */}
      <div style={{
        fontSize: tokens.typography.fontSize.base,
        fontWeight: 700,
        color: tokens.colors.text.primary,
        marginBottom: tokens.spacing[3],
        letterSpacing: '0.3px',
      }}>
        {t('fearGreedTitle')}
      </div>

      {/* Gauge SVG - centered */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
        <svg width="200" height="110" viewBox="0 0 200 110" style={{ overflow: 'visible' }}>
          <defs>
            <filter id="gaugeGlow">
              <feGaussianBlur stdDeviation="3" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <filter id="needleShadow">
              <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor={color} floodOpacity="0.5" />
            </filter>
          </defs>

          {/* Background track segments */}
          {segments.map((seg, i) => (
            <path
              key={i}
              d={describeArc(cx, cy, r, seg.from, seg.to)}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeW}
              strokeLinecap="butt"
              opacity={0.15}
            />
          ))}

          {/* Active arc segments */}
          {segments.map((seg, i) => {
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
                filter="url(#gaugeGlow)"
              />
            )
          })}

          {/* Scale labels */}
          {scaleLabels.map(sl => {
            const rad = (sl.deg * Math.PI) / 180
            const lx = cx + (r + 16) * Math.cos(rad)
            const ly = cy - (r + 16) * Math.sin(rad)
            return (
              <text
                key={sl.val}
                x={lx}
                y={ly}
                textAnchor="middle"
                dominantBaseline="middle"
                fill={tokens.colors.text.tertiary}
                fontSize="9"
                fontWeight="500"
              >
                {sl.text}
              </text>
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
            filter="url(#needleShadow)"
          />
          {/* Needle center */}
          <circle cx={cx} cy={cy} r="5" fill={color} />
          <circle cx={cx} cy={cy} r="2.5" fill={tokens.colors.bg.primary} />

          {/* Value text in center */}
          <text
            x={cx}
            y={cy + 20}
            textAnchor="middle"
            dominantBaseline="middle"
            fill={color}
            fontSize="28"
            fontWeight="800"
            fontFamily="monospace"
          >
            {displayValue}
          </text>
        </svg>

        {/* Label below gauge */}
        <div style={{
          marginTop: tokens.spacing[2],
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
        }}>
          <span style={{
            fontSize: tokens.typography.fontSize.md,
            fontWeight: 700,
            color,
            letterSpacing: '0.5px',
            transition: `color ${tokens.transition.slow}`,
          }}>
            {label}
          </span>
          {data.timestamp && (
            <span style={{
              fontSize: tokens.typography.fontSize.xs,
              color: tokens.colors.text.tertiary,
            }}>
              {new Date(Number(data.timestamp) * 1000).toLocaleDateString('zh-CN')}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
