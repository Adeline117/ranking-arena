'use client'

interface StartStepProps {
  tr: (key: string) => string
  onStart: () => void
}

export default function StartStep({ tr, onStart }: StartStepProps) {
  return (
    <div className="quiz-start-content">
      {/* Animated floating icon */}
      <div className="quiz-start-icon">
        <svg
          width="38"
          height="38"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>

      {/* Title with dramatic hierarchy */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <h1 className="quiz-start-title">{tr('quizTitle')}</h1>
        <p className="quiz-start-subtitle">{tr('quizSubtitle')}</p>
      </div>

      {/* Info badges — reward first, effort last */}
      <div className="quiz-badge-row">
        {['quizBadge12Types', 'quizBadgeLegend', 'quizBadge5Min'].map((key) => (
          <span key={key} className="quiz-badge">
            {tr(key) !== key ? tr(key) : key === 'quizBadgeLegend' ? 'Match a Legend' : tr(key)}
          </span>
        ))}
      </div>

      {/* Premium CTA button */}
      <button type="button" onClick={onStart} className="quiz-start-btn">
        {tr('quizStartBtn')}
      </button>
    </div>
  )
}
