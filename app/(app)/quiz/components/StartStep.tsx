'use client'

import { tokens } from '@/lib/design-tokens'

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
          background: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 8px 32px rgba(139, 92, 246, 0.3)',
        }}
      >
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 2L2 7l10 5 10-5-10-5z" />
          <path d="M2 17l10 5 10-5" />
          <path d="M2 12l10 5 10-5" />
        </svg>
      </div>

      {/* Title */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h1
          style={{
            fontSize: 'clamp(24px, 5vw, 32px)',
            fontWeight: tokens.typography.fontWeight.bold,
            color: 'var(--color-text-primary)',
            lineHeight: 1.2,
            margin: 0,
          }}
        >
          {tr('quizTitle')}
        </h1>
        <p
          style={{
            fontSize: tokens.typography.fontSize.base,
            color: 'var(--color-text-secondary)',
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
            background: 'var(--color-overlay-subtle)',
            border: '1px solid var(--glass-border-light)',
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-secondary)',
          }}
        >
          {tr('quizBadge15Q')}
        </span>
        <span
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            background: 'var(--color-overlay-subtle)',
            border: '1px solid var(--glass-border-light)',
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-secondary)',
          }}
        >
          {tr('quizBadge8Types')}
        </span>
        <span
          style={{
            padding: '6px 14px',
            borderRadius: 8,
            background: 'var(--color-overlay-subtle)',
            border: '1px solid var(--glass-border-light)',
            fontSize: tokens.typography.fontSize.sm,
            color: 'var(--color-text-secondary)',
          }}
        >
          {tr('quizBadge2Min')}
        </span>
      </div>

      {/* Start button */}
      <button
        onClick={onStart}
        style={{
          padding: '14px 48px',
          borderRadius: 12,
          background: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)',
          border: 'none',
          color: '#fff',
          fontSize: tokens.typography.fontSize.lg,
          fontWeight: tokens.typography.fontWeight.bold,
          cursor: 'pointer',
          transition: 'transform 0.2s, box-shadow 0.2s',
          boxShadow: '0 4px 20px rgba(139, 92, 246, 0.35)',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-2px)'
          e.currentTarget.style.boxShadow = '0 8px 30px rgba(139, 92, 246, 0.5)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)'
          e.currentTarget.style.boxShadow = '0 4px 20px rgba(139, 92, 246, 0.35)'
        }}
      >
        {tr('quizStartBtn')}
      </button>
    </div>
  )
}
