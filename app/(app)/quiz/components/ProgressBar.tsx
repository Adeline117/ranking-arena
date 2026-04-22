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
  const percent = total > 0 ? Math.round((answered / total) * 100) : 0

  const handleDotClick = (qId: number) => {
    const el = document.getElementById(`quiz-q-${qId}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  return (
    <div className="quiz-progress-wrapper">
      {/* Header: count + percentage */}
      <div className="quiz-progress-header">
        <span className="quiz-progress-count">
          {answered} / {total}
        </span>
        <span className="quiz-progress-percent">
          {percent}%
        </span>
      </div>

      {/* Continuous progress track with glowing leading edge */}
      <div
        className="quiz-progress-track"
        role="progressbar"
        aria-valuenow={answered}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-label={`${answered} of ${total} answered`}
      >
        <div
          className="quiz-progress-fill"
          style={{ width: `${percent}%` }}
        />
      </div>

      {/* Clickable dots overlay */}
      <div className="quiz-progress-dots">
        {questionIds.map((qId, idx) => {
          const isDone = answeredIds.has(qId)
          return (
            <button
              key={qId}
              type="button"
              onClick={() => handleDotClick(qId)}
              aria-label={`Question ${idx + 1}${isDone ? ' (answered)' : ' (unanswered)'}`}
              className="quiz-progress-dot"
              data-done={isDone ? 'true' : 'false'}
            >
              <span aria-hidden="true" className="quiz-dot-touch" />
            </button>
          )
        })}
      </div>
    </div>
  )
}
