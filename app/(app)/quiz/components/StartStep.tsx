'use client'

import { tokens } from '@/lib/design-tokens'

/** Forced dark-theme palette */
const Q = {
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: 'rgba(255,255,255,0.7)',
  BRAND: '#8B5CF6',
  BRAND_DEEP: '#6D28D9',
  BADGE_BG: 'rgba(139, 92, 246, 0.12)',
  BADGE_BORDER: 'rgba(139, 92, 246, 0.25)',
} as const

interface StartStepProps {
  tr: (key: string) => string
  onStart: () => void
}

export default function StartStep({ tr, onStart }: StartStepProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        gap: 24,
        animation: 'fadeIn 0.5s ease-out',
      }}
    >
      {/* Icon */}
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: 20,
          background: `linear-gradient(135deg, ${Q.BRAND} 0%, ${Q.BRAND_DEEP} 100%)`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: `0 8px 32px rgba(139, 92, 246, 0.3)`,
        }}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      {/* Title */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1
          style={{
            fontSize: 'clamp(28px, 6vw, 38px)',
            fontWeight: tokens.typography.fontWeight.bold,
            color: Q.TEXT_PRIMARY,
            lineHeight: 1.2,
            margin: 0,
            letterSpacing: '-0.02em',
          }}
        >
          {tr('quizTitle')}
        </h1>
        <p
          style={{
            fontSize: tokens.typography.fontSize.base,
            color: Q.TEXT_SECONDARY,
            lineHeight: 1.6,
            margin: 0,
            maxWidth: 400,
          }}
        >
          {tr('quizSubtitle')}
        </p>
      </div>

      {/* Info badges */}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', justifyContent: 'center' }}>
        <span
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            background: Q.BADGE_BG,
            border: `1px solid ${Q.BADGE_BORDER}`,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            color: Q.TEXT_PRIMARY,
          }}
        >
          {tr('quizBadge15Q')}
        </span>
        <span
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            background: Q.BADGE_BG,
            border: `1px solid ${Q.BADGE_BORDER}`,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            color: Q.TEXT_PRIMARY,
          }}
        >
          {tr('quizBadge8Types')}
        </span>
        <span
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            background: Q.BADGE_BG,
            border: `1px solid ${Q.BADGE_BORDER}`,
            fontSize: tokens.typography.fontSize.sm,
            fontWeight: tokens.typography.fontWeight.medium,
            color: Q.TEXT_PRIMARY,
          }}
        >
          {tr('quizBadge2Min')}
        </span>
      </div>

      {/* Start button */}
      <button
        onClick={onStart}
        style={{
          padding: '16px 56px',
          borderRadius: 14,
          background: `linear-gradient(135deg, ${Q.BRAND} 0%, ${Q.BRAND_DEEP} 100%)`,
          border: 'none',
          color: '#fff',
          fontSize: 'clamp(16px, 4vw, 20px)',
          fontWeight: tokens.typography.fontWeight.bold,
          cursor: 'pointer',
          transition: 'transform 0.2s, box-shadow 0.2s',
          boxShadow: '0 4px 24px rgba(139, 92, 246, 0.4), 0 0 60px rgba(139, 92, 246, 0.15)',
          letterSpacing: '0.02em',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.boxShadow = '0 8px 30px rgba(139, 92, 246, 0.5), 0 0 80px rgba(139, 92, 246, 0.2)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = '0 4px 24px rgba(139, 92, 246, 0.4), 0 0 60px rgba(139, 92, 246, 0.15)'
        }}
      >
        {tr('quizStartBtn')}
      </button>
    </div>
  )
}
