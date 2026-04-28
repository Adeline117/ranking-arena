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
  'tourist',
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

// Rarity tier classification
function getRarityTier(percent: number): {
  label: string
  symbol: string
  tier: 'legendary' | 'epic' | 'rare' | 'common'
} {
  if (percent <= 3) return { label: 'Legendary', symbol: '\u25C6', tier: 'legendary' }
  if (percent <= 5) return { label: 'Ultra Rare', symbol: '\u25C6', tier: 'epic' }
  if (percent <= 9) return { label: 'Rare', symbol: '\u2605', tier: 'rare' }
  return { label: 'Common', symbol: '\u25A3', tier: 'common' }
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

  const hasArt = TYPES_WITH_ART.has(type.id)
  const typeColor = TYPE_TEXT_COLOR[type.id] || type.color
  const rarityPercent = TYPE_RARITY[type.id]
  const rarity = rarityPercent ? getRarityTier(rarityPercent) : null

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

      {/* Grain texture overlay */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          backgroundImage:
            "url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E\")",
          opacity: 0.03,
          mixBlendMode: 'overlay' as const,
          pointerEvents: 'none',
          zIndex: 2,
          borderRadius: 'inherit',
        }}
      />

      {/* Inner card border glow — type-colored edge light */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          borderRadius: 'inherit',
          border: `1px solid ${type.color}18`,
          boxShadow: `inset 0 0 80px ${type.color}08, inset 0 1px 0 rgba(255,255,255,0.04)`,
          pointerEvents: 'none',
          zIndex: 1,
        }}
      />

      {/* ---- Hero character illustration ---- */}
      <div
        className="quiz-hero-icon"
        style={{
          background: hasArt ? '#111118' : `${type.color}10`,
          border: 'none',
          width: hasArt ? 'clamp(200px, 56vw, 260px)' : 'clamp(64px, 18vw, 80px)',
          height: hasArt ? 'clamp(200px, 56vw, 260px)' : 'clamp(64px, 18vw, 80px)',
          borderRadius: hasArt ? '50%' : 'clamp(14px, 3vw, 20px)',
          overflow: 'hidden',
          position: 'relative',
          boxShadow: hasArt
            ? `0 0 0 3px ${type.color}30, 0 0 0 6px ${type.color}12, 0 12px 40px ${type.color}25, 0 4px 16px rgba(0,0,0,0.3)`
            : `0 12px 32px ${type.color}25`,
        }}
      >
        {hasArt ? (
          <Image
            src={`/images/quiz/${type.id}.jpg`}
            alt={tr(type.nameKey)}
            width={260}
            height={520}
            style={{
              objectFit: 'cover',
              objectPosition: 'center 35%',
              display: 'block',
              width: '100%',
              height: '100%',
            }}
            priority
            unoptimized
          />
        ) : (
          <QuizIcon name={type.icon} color={type.color} size={34} />
        )}
      </div>

      {/* ---- Rarity badge — positioned above the type name ---- */}
      {rarity && rarityPercent && (
        <span
          style={{
            fontSize: 'clamp(11px, 2.8vw, 12px)',
            fontWeight: 700,
            color: type.color,
            padding: 'clamp(5px, 1.2vw, 7px) clamp(12px, 3vw, 18px)',
            borderRadius: 'clamp(16px, 4vw, 20px)',
            background: `rgba(${hexToRgb(type.color)}, 0.06)`,
            border: `1px solid ${type.color}35`,
            letterSpacing: '0.06em',
            textTransform: 'uppercase' as const,
            boxShadow: `0 0 20px ${type.color}15, 0 0 40px ${type.color}08`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'clamp(5px, 1.2vw, 7px)',
            animation: 'quizTextReveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.35s both',
          }}
        >
          <span
            style={{
              fontSize: 'clamp(10px, 2.5vw, 12px)',
              fontWeight: 800,
              filter: `drop-shadow(0 0 4px ${type.color}80)`,
            }}
          >
            {rarity.symbol}
          </span>
          {rarity.label}
          <span
            style={{
              width: 1,
              height: 12,
              background: `${type.color}40`,
              flexShrink: 0,
            }}
          />
          <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 800 }}>
            Top {rarityPercent}%
          </span>
        </span>
      )}

      {/* ---- Type name — huge hero weight ---- */}
      <h2
        className="quiz-hero-type-name"
        style={{
          color: typeColor,
          fontSize: 'clamp(32px, 9vw, 48px)',
          fontWeight: 800,
          margin: 0,
          textAlign: 'center',
          letterSpacing: '-0.03em',
          lineHeight: 1.05,
          textShadow: `0 0 40px ${type.color}30, 0 2px 4px rgba(0,0,0,0.3)`,
          animation: 'quizTextReveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.3s both',
        }}
      >
        {tr(type.nameKey)}
      </h2>

      {/* ---- Match percentage section ---- */}
      <div
        className="quiz-match-section"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 'clamp(8px, 2vw, 12px)',
          width: '100%',
          maxWidth: 'clamp(240px, 60vw, 300px)',
          animation: 'quizTextReveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.4s both',
        }}
      >
        {/* Animated match counter */}
        <span
          style={{
            fontSize: 'clamp(28px, 7vw, 36px)',
            fontWeight: 800,
            color: typeColor,
            fontVariantNumeric: 'tabular-nums',
            letterSpacing: '-0.02em',
            lineHeight: 1,
            textShadow: `0 0 24px ${type.color}40`,
          }}
        >
          {animatedMatch}%
          <span
            style={{
              fontSize: 'clamp(13px, 3.2vw, 15px)',
              fontWeight: 600,
              color: 'var(--color-text-tertiary)',
              marginLeft: 'clamp(4px, 1vw, 6px)',
              letterSpacing: '0.02em',
            }}
          >
            {tr('quizMatch')}
          </span>
        </span>

        {/* Thick progress bar with inner glow */}
        <div
          className="quiz-match-bar-track"
          style={{
            width: '100%',
            height: 'clamp(16px, 4vw, 20px)',
            borderRadius: 'clamp(8px, 2vw, 10px)',
            background: 'var(--color-bg-tertiary, rgba(255,255,255,0.04))',
            overflow: 'hidden',
            boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.1)',
            position: 'relative',
          }}
        >
          <div
            className="quiz-match-bar-fill"
            style={{
              width: `${animatedWidth}%`,
              height: '100%',
              borderRadius: 'inherit',
              background: type.gradient,
              transition: 'width 1.2s cubic-bezier(0.16, 1, 0.3, 1)',
              position: 'relative',
              boxShadow: `0 0 16px ${type.color}50, 0 0 32px ${type.color}25, inset 0 1px 0 rgba(255,255,255,0.2)`,
            }}
          >
            {/* Inner glow pulse */}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                inset: 0,
                borderRadius: 'inherit',
                background: 'linear-gradient(180deg, rgba(255,255,255,0.15) 0%, transparent 60%)',
              }}
            />
            {/* Glowing trailing edge */}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                right: -1,
                top: 1,
                bottom: 1,
                width: 'clamp(16px, 4vw, 24px)',
                borderRadius: '0 10px 10px 0',
                background: 'rgba(255,255,255,0.3)',
                filter: 'blur(4px)',
              }}
            />
          </div>
        </div>
      </div>

      {/* ---- Description ---- */}
      <p
        className="quiz-hero-description"
        style={{
          fontSize: 'clamp(13px, 3.2vw, 15px)',
          color: 'var(--color-text-secondary)',
          lineHeight: 1.7,
          textAlign: 'center',
          margin: 0,
          maxWidth: 'clamp(320px, 80vw, 440px)',
          animation: 'quizTextReveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.5s both',
        }}
      >
        {tr(type.descriptionKey)}
      </p>

      {/* ---- Secondary type badge — pill with type color tint ---- */}
      <span
        className="quiz-shadow-badge"
        style={{
          padding: 'clamp(6px, 1.5vw, 8px) clamp(14px, 3.5vw, 20px)',
          borderRadius: 'clamp(18px, 4.5vw, 24px)',
          background: `rgba(${hexToRgb(type.color)}, 0.06)`,
          border: `1px solid ${type.color}22`,
          fontSize: 'clamp(12px, 3vw, 13px)',
          fontWeight: 600,
          color: 'var(--color-text-secondary)',
          animation: 'quizTextReveal 0.6s cubic-bezier(0.16, 1, 0.3, 1) 0.6s both',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 'clamp(4px, 1vw, 6px)',
        }}
      >
        <span style={{ color: `${type.color}CC`, fontWeight: 700 }}>{tr('quizShadowType')}</span>
        <span style={{ color: typeColor, fontWeight: 700 }}>{secondaryTypeLabel}</span>
      </span>
    </div>
  )
}

/** Convert hex color to r,g,b string for use in rgba() */
function hexToRgb(hex: string): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `${r},${g},${b}`
}
