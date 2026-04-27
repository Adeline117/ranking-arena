'use client'

import { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import type { PersonalityType } from '../../components/types'
import { TYPE_TEXT_COLOR } from '../../components/quiz-data'
import { QuizIcon } from './QuizIcon'

// Types that have dedicated character illustrations
const TYPES_WITH_ART = new Set([
  'sniper',
  'analyst',
  'strategist',
  'hodler',
  'narrator',
  'whale',
  'scalper',
  'copycat',
  'contrarian',
  'degen',
  'paperhands',
])

// Approximate rarity distribution per type (updated periodically)
const TYPE_RARITY: Record<string, number> = {
  sniper: 8,
  scalper: 11,
  whale: 4,
  analyst: 9,
  contrarian: 5,
  hodler: 14,
  degen: 16,
  strategist: 7,
  copycat: 10,
  tourist: 8,
  paperhands: 5,
  narrator: 3,
}

interface PersonalityCardProps {
  type: PersonalityType
  matchPercent: number
  secondaryTypeLabel: string
  tr: (key: string) => string
}

/** Animated counter from 0 to target value with ease-out deceleration */
function useAnimatedCounter(target: number, duration: number = 1200): number {
  const [value, setValue] = useState(0)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    // Delay so card entrance animation plays first
    const delay = setTimeout(() => {
      startRef.current = null
      const tick = (timestamp: number) => {
        if (startRef.current === null) startRef.current = timestamp
        const elapsed = timestamp - startRef.current
        const progress = Math.min(elapsed / duration, 1)
        // Cubic ease-out for satisfying deceleration
        const eased = 1 - Math.pow(1 - progress, 3)
        setValue(Math.round(eased * target))
        if (progress < 1) {
          requestAnimationFrame(tick)
        }
      }
      requestAnimationFrame(tick)
    }, 400)
    return () => clearTimeout(delay)
  }, [target, duration])

  return value
}

export default function PersonalityCard({
  type,
  matchPercent,
  secondaryTypeLabel,
  tr,
}: PersonalityCardProps) {
  const [animatedWidth, setAnimatedWidth] = useState(0)
  const animatedMatch = useAnimatedCounter(matchPercent, 1200)
  const [showConfetti, setShowConfetti] = useState(false)

  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      setAnimatedWidth(matchPercent)
    })
    // Delay confetti 400ms so card entrance animation finishes first
    const showTimer = setTimeout(() => setShowConfetti(true), 400)
    // Hide confetti after animation completes to clean up DOM
    const hideTimer = setTimeout(() => setShowConfetti(false), 2400)
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(showTimer)
      clearTimeout(hideTimer)
    }
  }, [matchPercent])

  return (
    <div
      className="quiz-personality-card"
      style={
        {
          // CSS custom properties for type-specific theming
          '--quiz-type-color': type.color,
          '--quiz-type-color-08': `${type.color}14`,
          '--quiz-type-color-15': `${type.color}26`,
          '--quiz-type-color-25': `${type.color}40`,
          '--quiz-type-gradient': type.gradient,
        } as React.CSSProperties
      }
    >
      {/* Confetti burst on reveal */}
      {showConfetti && (
        <div className="quiz-confetti" aria-hidden="true">
          {[
            type.color,
            'var(--color-brand)',
            `${type.color}CC`,
            '#FFD700',
            'var(--color-brand-deep)',
            `${type.color}99`,
            '#FFFFFF',
            type.color,
            '#FFD700',
            'var(--color-brand)',
          ].map((c, i) => (
            <span key={i} style={{ background: c }} />
          ))}
        </div>
      )}

      {/* Hero character illustration (or SVG fallback for types without art) */}
      <div
        className="quiz-hero-icon"
        style={{
          background: TYPES_WITH_ART.has(type.id)
            ? `linear-gradient(160deg, ${type.color}22 0%, ${type.color}08 100%)`
            : `${type.color}10`,
          border: `1px solid ${type.color}30`,
          width: TYPES_WITH_ART.has(type.id) ? 148 : 72,
          height: TYPES_WITH_ART.has(type.id) ? 148 : 72,
          borderRadius: TYPES_WITH_ART.has(type.id) ? 28 : 18,
          overflow: 'hidden',
          boxShadow: TYPES_WITH_ART.has(type.id)
            ? `0 0 0 1px ${type.color}20, 0 12px 36px ${type.color}30, inset 0 1px 0 rgba(255,255,255,0.06)`
            : `0 8px 24px ${type.color}25`,
        }}
      >
        {TYPES_WITH_ART.has(type.id) ? (
          <Image
            src={`/images/quiz/${type.id}.jpg`}
            alt={tr(type.nameKey)}
            width={148}
            height={148}
            style={{
              objectFit: 'cover',
              objectPosition: 'center',
              display: 'block',
            }}
            priority
            unoptimized
          />
        ) : (
          <QuizIcon name={type.icon} color={type.color} size={34} />
        )}
      </div>

      {/* Type name — large hero weight */}
      <h2 className="quiz-hero-type-name" style={{ color: TYPE_TEXT_COLOR[type.id] || type.color }}>
        {tr(type.nameKey)}
      </h2>

      {/* Animated match percentage — counts up from 0 */}
      <div className="quiz-match-section">
        <div className="quiz-match-bar-track">
          <div
            className="quiz-match-bar-fill"
            style={{
              width: `${animatedWidth}%`,
              background: type.gradient,
            }}
          />
        </div>
        <span className="quiz-match-label" style={{ color: type.color }}>
          {animatedMatch}% {tr('quizMatch')}
        </span>
      </div>

      {/* Description */}
      <p className="quiz-hero-description">{tr(type.descriptionKey)}</p>

      {/* Rarity badge — prominent social proof */}
      {TYPE_RARITY[type.id] && (
        <span
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: type.color,
            padding: '7px 16px',
            borderRadius: 24,
            background: `${type.color}18`,
            border: `1px solid ${type.color}40`,
            letterSpacing: '0.02em',
            boxShadow: `0 2px 12px ${type.color}20`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span style={{ fontSize: 15 }}>
            {TYPE_RARITY[type.id] <= 5 ? '💎' : TYPE_RARITY[type.id] <= 9 ? '⭐' : '📊'}
          </span>
          {TYPE_RARITY[type.id] <= 5
            ? `Top ${TYPE_RARITY[type.id]}% — Ultra Rare`
            : `Only ${TYPE_RARITY[type.id]}% of traders`}
        </span>
      )}

      {/* Secondary type badge — pill-shaped */}
      <span className="quiz-shadow-badge">
        {tr('quizShadowType')}: {secondaryTypeLabel}
      </span>
    </div>
  )
}
