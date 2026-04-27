'use client'

import Image from 'next/image'

interface StartStepProps {
  tr: (key: string) => string
  onStart: () => void
}

export default function StartStep({ tr, onStart }: StartStepProps) {
  return (
    <div className="quiz-start-content">
      {/* Floating ambient orbs */}
      <div className="quiz-start-orbs" aria-hidden="true">
        <div className="quiz-orb quiz-orb-1" />
        <div className="quiz-orb quiz-orb-2" />
        <div className="quiz-orb quiz-orb-3" />
      </div>

      {/* Arena logo with pulsing glow */}
      <div className="quiz-start-logo-wrap">
        <div className="quiz-start-logo-pulse" />
        <div className="quiz-start-logo">
          <Image src="/logo-symbol.png" alt="Arena" width={48} height={48} priority />
        </div>
      </div>

      {/* Title block */}
      <div className="quiz-start-text">
        <h1 className="quiz-start-title">{tr('quizTitle')}</h1>
        <p className="quiz-start-subtitle">{tr('quizSubtitle')}</p>
      </div>

      {/* Feature highlights */}
      <div className="quiz-badge-row">
        <span className="quiz-badge">
          <span className="quiz-badge-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </span>
          {tr('quizBadge12Types') !== 'quizBadge12Types'
            ? tr('quizBadge12Types')
            : '12 Personalities'}
        </span>
        <span className="quiz-badge">
          <span className="quiz-badge-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
            </svg>
          </span>
          Match a Legend
        </span>
        <span className="quiz-badge">
          <span className="quiz-badge-icon">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="12 6 12 12 16 14" />
            </svg>
          </span>
          {tr('quizBadge5Min') !== 'quizBadge5Min' ? tr('quizBadge5Min') : '~5 min'}
        </span>
      </div>

      {/* CTA button */}
      <button type="button" onClick={onStart} className="quiz-start-btn">
        <span>{tr('quizStartBtn') !== 'quizStartBtn' ? tr('quizStartBtn') : 'Start Test'}</span>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </svg>
      </button>
    </div>
  )
}
