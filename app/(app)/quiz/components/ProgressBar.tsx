'use client'

interface ProgressBarProps {
  answered: number
  total: number
  /** Question IDs in order */
  questionIds: number[]
  /** Set of answered question IDs */
  answeredIds: Set<number>
}

export default function ProgressBar({ answered, total, questionIds, answeredIds }: ProgressBarProps) {
  const handleDotClick = (qId: number) => {
    const el = document.getElementById(`quiz-q-${qId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Counter */}
      <span
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: 'var(--color-text-tertiary)',
          opacity: 0.85,
        }}
        aria-hidden="true"
      >
        {answered} / {total}
      </span>

      {/* Clickable dots — each dot = one question */}
      <div
        role="progressbar"
        aria-valuenow={answered}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${answered} of ${total} answered`}
        style={{
          display: 'flex',
          gap: 3,
          flexWrap: 'wrap',
        }}
      >
        {questionIds.map((qId, idx) => {
          const isDone = answeredIds.has(qId)
          return (
            <button
              key={qId}
              type="button"
              onClick={() => handleDotClick(qId)}
              aria-label={`Question ${idx + 1}${isDone ? ' (answered)' : ' (unanswered)'}`}
              style={{
                position: 'relative',
                width: 14,
                height: 6,
                borderRadius: 3,
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                background: isDone
                  ? 'var(--color-brand)'
                  : 'var(--color-bg-tertiary)',
                transition: 'background 0.3s, transform 0.2s',
                flex: 'none',
              }}
              onMouseEnter={(e) => {
                if (!isDone) e.currentTarget.style.background = 'var(--color-brand-accent)'
              }}
              onMouseLeave={(e) => {
                if (!isDone) e.currentTarget.style.background = 'var(--color-bg-tertiary)'
              }}
            >
              {/* Invisible touch target expander — 30px tall hit area */}
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  top: -12,
                  bottom: -12,
                  left: -2,
                  right: -2,
                }}
              />
            </button>
          )
        })}
      </div>
    </div>
  )
}
