'use client'

import { useState } from 'react'
import type { QuizQuestion } from './types'

interface QuestionStepProps {
  question: QuizQuestion
  selectedOption: string | undefined
  tr: (key: string) => string
  onSelect: (optionId: string) => void
  onBack: () => void
}

export default function QuestionStep({ question, selectedOption, tr, onSelect, onBack }: QuestionStepProps) {
  const [animating, setAnimating] = useState(false)

  const handleSelect = (optionId: string) => {
    if (animating) return
    setAnimating(true)
    onSelect(optionId)
    // Reset animation state after transition
    setTimeout(() => setAnimating(false), 400)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
        animation: 'fadeIn 0.35s ease-out',
      }}
    >
      {/* Question text */}
      <h2
        style={{
          fontSize: 'clamp(16px, 3.5vw, 18px)',
          fontWeight: 600,
          color: 'var(--color-text-primary)',
          lineHeight: 1.4,
          margin: 0,
        }}
      >
        {tr(question.titleKey)}
      </h2>

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {question.options.map((option, idx) => {
          const isSelected = selectedOption === option.id
          return (
            <button
              key={option.id}
              onClick={() => handleSelect(option.id)}
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
                animation: `fadeIn 0.3s ease-out ${idx * 0.05}s both`,
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
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
                if (!isSelected) {
                  e.currentTarget.style.borderColor = 'var(--glass-border-light)'
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

      {/* Back button */}
      <button
        onClick={onBack}
        style={{
          alignSelf: 'flex-start',
          padding: '8px 0',
          minHeight: 36,
          borderRadius: 0,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-tertiary)',
          fontSize: 13,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
          transition: 'color 0.2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-primary)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-tertiary)' }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {tr('quizBack')}
      </button>
    </div>
  )
}
