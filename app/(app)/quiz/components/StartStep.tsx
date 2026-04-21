'use client'

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
        gap: 20,
        animation: 'fadeIn 0.5s ease-out',
      }}
    >
      {/* Icon */}
      <div
        style={{
          width: 64,
          height: 64,
          borderRadius: 16,
          background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 16px color-mix(in srgb, var(--color-brand) 25%, transparent)',
        }}
      >
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      {/* Title */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h1
          style={{
            fontSize: 'clamp(22px, 5vw, 28px)',
            fontWeight: 700,
            color: 'var(--color-text-primary)',
            lineHeight: 1.2,
            margin: 0,
          }}
        >
          {tr('quizTitle')}
        </h1>
        <p
          style={{
            fontSize: 14,
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
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        {['quizBadge15Q', 'quizBadge8Types', 'quizBadge2Min'].map((key) => (
          <span
            key={key}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              background: 'var(--color-accent-primary-08)',
              border: '1px solid transparent',
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--color-brand)',
            }}
          >
            {tr(key)}
          </span>
        ))}
      </div>

      {/* Start button */}
      <button
        onClick={onStart}
        style={{
          padding: '12px 32px',
          borderRadius: 8,
          background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))',
          border: 'none',
          color: '#fff',
          fontSize: 15,
          fontWeight: 600,
          cursor: 'pointer',
          transition: 'transform 0.2s',
          minWidth: 200,
          width: '100%',
          maxWidth: 280,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.transform = 'translateY(-1px)'
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'translateY(0)'
        }}
      >
        {tr('quizStartBtn')}
      </button>
    </div>
  )
}
