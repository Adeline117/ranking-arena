'use client'

import type { QuizQuestion } from './types'

interface QuestionStepProps {
  question: QuizQuestion
  questionNumber: number
  totalQuestions: number
  selectedOption: string | undefined
  tr: (key: string) => string
  onSelect: (optionId: string) => void
}

export default function QuestionStep({ question, questionNumber, totalQuestions, selectedOption, tr, onSelect }: QuestionStepProps) {
  return (
    <div
      id={`quiz-q-${question.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: 'clamp(16px, 3vw, 24px)',
        background: 'var(--color-bg-secondary)',
        border: '1px solid var(--glass-border-light)',
        borderRadius: 12,
      }}
    >
      {/* Question text */}
      <h2
        style={{
          fontSize: 'clamp(15px, 3.5vw, 17px)',
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          lineHeight: 1.4,
          margin: 0,
        }}
      >
        <span
          style={{
            color: 'var(--color-brand)',
            fontWeight: 700,
            marginRight: 8,
          }}
        >
          Q{questionNumber}
        </span>
        {tr(question.titleKey)}
      </h2>

      {/* Options */}
      <div
        role="group"
        aria-label={`Question ${questionNumber} of ${totalQuestions}`}
        style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
      >
        {question.options.map((option, idx) => {
          const isSelected = selectedOption === option.id
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onSelect(option.id)}
              aria-pressed={isSelected}
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: 8,
                border: isSelected
                  ? '1px solid var(--color-brand)'
                  : '1px solid var(--glass-border-light)',
                background: isSelected
                  ? 'var(--color-accent-primary-08)'
                  : 'var(--color-bg-tertiary)',
                color: 'var(--color-text-primary)',
                fontSize: 14,
                fontWeight: isSelected ? 600 : 500,
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
              }}
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'scale(0.98)'
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.borderColor = 'var(--color-text-tertiary)'
                  e.currentTarget.style.background = 'var(--color-bg-secondary)'
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
                if (!isSelected) {
                  e.currentTarget.style.borderColor = 'var(--glass-border-light)'
                  e.currentTarget.style.background = 'var(--color-bg-tertiary)'
                }
              }}
            >
              <span
                style={{
                  width: 24,
                  height: 24,
                  borderRadius: 6,
                  background: isSelected
                    ? 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))'
                    : 'var(--color-bg-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  color: isSelected ? '#fff' : 'var(--color-text-tertiary)',
                  flexShrink: 0,
                }}
              >
                {String.fromCharCode(65 + idx)}
              </span>
              <span>{tr(option.labelKey)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
