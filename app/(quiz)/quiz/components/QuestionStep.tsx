'use client'

import React from 'react'
import type { QuizQuestion } from './types'

interface QuestionStepProps {
  question: QuizQuestion
  questionNumber: number
  totalQuestions: number
  selectedOption: string | undefined
  tr: (key: string) => string
  onSelect: (questionId: number, optionId: string) => void
}

/* Yes/No/Unsure icon config */
const YESNO_ICON: Record<string, string> = {
  yes: '\u2713',
  no: '\u2717',
  unsure: '?',
}

const QuestionStep = React.memo(function QuestionStep({
  question,
  questionNumber,
  totalQuestions,
  selectedOption,
  tr,
  onSelect,
}: QuestionStepProps) {
  const isYesNo = question.format === 'yesno'
  const isEven = questionNumber % 2 === 0
  const isAnswered = selectedOption !== undefined

  return (
    <div
      id={`quiz-q-${question.id}`}
      className="quiz-question-card"
      data-even={isEven ? 'true' : 'false'}
      data-answered={isAnswered ? 'true' : 'false'}
    >
      {/* Answered checkmark badge */}
      {isAnswered && (
        <span
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: 'var(--color-accent-success)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: '#fff',
            fontWeight: 700,
          }}
        >
          &#x2713;
        </span>
      )}
      {/* Question text with milestone badge */}
      <h2 className="quiz-q-title">
        <span className="quiz-q-number">{questionNumber}</span>
        <span>{tr(question.titleKey)}</span>
      </h2>

      {/* Options */}
      {isYesNo ? (
        /* Yes / No / Unsure: 3 horizontal buttons */
        <div
          role="radiogroup"
          aria-label={`Question ${questionNumber} of ${totalQuestions}`}
          style={{ display: 'flex', gap: 8 }}
        >
          {['yes', 'unsure', 'no']
            .map((id) => question.options.find((o) => o.id === id))
            .filter(Boolean)
            .map((option) => {
              if (!option) return null
              const isSelected = selectedOption === option.id
              return (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => onSelect(question.id, option.id)}
                  role="radio"
                  aria-checked={isSelected}
                  className="quiz-yesno-btn"
                >
                  <span aria-hidden="true" style={{ fontSize: 16, fontWeight: 700 }}>
                    {YESNO_ICON[option.id] ?? '?'}
                  </span>
                  <span>{tr(option.labelKey)}</span>
                </button>
              )
            })}
        </div>
      ) : (
        /* Standard A/B/C/D: 4 vertical buttons */
        <div
          role="radiogroup"
          aria-label={`Question ${questionNumber} of ${totalQuestions}`}
          style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          {question.options.map((option, idx) => {
            const isSelected = selectedOption === option.id
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => onSelect(question.id, option.id)}
                role="radio"
                aria-checked={isSelected}
                className="quiz-option-btn"
              >
                <span aria-hidden="true" className="quiz-option-letter">
                  {String.fromCharCode(65 + idx)}
                </span>
                <span>{tr(option.labelKey)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
})

export default QuestionStep
