'use client'

import Image from 'next/image'

interface StartStepProps {
  tr: (key: string) => string
  onStart: () => void
}

export default function StartStep({ tr, onStart }: StartStepProps) {
  return (
    <div className="quiz-start-content">
      {/* Arena logo with glow ring */}
      <div className="quiz-start-logo-wrap">
        <div className="quiz-start-logo-ring" />
        <div className="quiz-start-logo">
          <Image src="/logo-symbol.png" alt="Arena" width={52} height={52} priority />
        </div>
      </div>

      {/* Title with dramatic hierarchy */}
      <div className="quiz-start-text">
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
