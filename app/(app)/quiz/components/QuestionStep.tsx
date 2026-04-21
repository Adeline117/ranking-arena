'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
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
        gap: 24,
        animation: 'fadeIn 0.35s ease-out',
      }}
    >
      {/* Question text */}
      <h2
        style={{
          fontSize: 'clamp(18px, 4vw, 22px)',
          fontWeight: tokens.typography.fontWeight.bold,
          color: 'var(--color-text-primary)',
          lineHeight: 1.4,
          margin: 0,
        }}
      >
        {tr(question.titleKey)}
      </h2>

      {/* Options */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {question.options.map((option, idx) => {
          const isSelected = selectedOption === option.id
          return (
            <button
              key={option.id}
              onClick={() => handleSelect(option.id)}
              style={{
                width: '100%',
                padding: '14px 18px',
                borderRadius: 12,
                border: isSelected
                  ? '2px solid var(--color-brand)'
                  : '1px solid var(--glass-border-light)',
                background: isSelected
                  ? 'linear-gradient(135deg, var(--color-accent-primary-15) 0%, var(--color-accent-primary-08) 100%)'
                  : 'var(--color-overlay-subtle)',
                color: 'var(--color-text-primary)',
                fontSize: tokens.typography.fontSize.base,
                fontWeight: isSelected ? tokens.typography.fontWeight.semibold : tokens.typography.fontWeight.medium,
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                animation: `fadeIn 0.3s ease-out ${idx * 0.05}s both`,
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.borderColor = 'var(--color-accent-primary-40)'
                  e.currentTarget.style.background = 'var(--color-overlay-medium)'
                }
              }}
              onMouseLeave={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.borderColor = 'var(--glass-border-light)'
                  e.currentTarget.style.background = 'var(--color-overlay-subtle)'
                }
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: isSelected
                    ? 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-deep) 100%)'
                    : 'var(--color-overlay-medium)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.bold,
                  color: isSelected ? '#fff' : 'var(--color-text-secondary)',
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
          padding: '8px 16px',
          borderRadius: 8,
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-secondary)',
          fontSize: tokens.typography.fontSize.sm,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          transition: 'color 0.2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--color-text-primary)' }}
        onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--color-text-secondary)' }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {tr('quizBack')}
      </button>
    </div>
  )
}
