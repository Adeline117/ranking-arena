'use client'

import { useState } from 'react'
import { tokens } from '@/lib/design-tokens'
import type { QuizQuestion } from './types'

/** Forced dark-theme palette */
const Q = {
  TEXT_PRIMARY: '#FFFFFF',
  TEXT_SECONDARY: 'rgba(255,255,255,0.5)',
  BG_OPTION: 'rgba(255,255,255,0.04)',
  BORDER: 'rgba(255,255,255,0.08)',
  BORDER_HOVER: 'rgba(255,255,255,0.15)',
  HOVER_BG: 'rgba(255,255,255,0.06)',
  SELECTED_BG: 'rgba(139, 92, 246, 0.15)',
  SELECTED_BORDER: 'rgba(139, 92, 246, 0.6)',
  BRAND: '#8B5CF6',
  BRAND_DEEP: '#6D28D9',
  LETTER_BG: 'rgba(255,255,255,0.06)',
  LETTER_COLOR: 'rgba(255,255,255,0.5)',
} as const

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
          color: Q.TEXT_PRIMARY,
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
                  ? `2px solid ${Q.SELECTED_BORDER}`
                  : `2px solid ${Q.BORDER}`,
                background: isSelected
                  ? Q.SELECTED_BG
                  : Q.BG_OPTION,
                color: Q.TEXT_PRIMARY,
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
              onMouseDown={(e) => {
                e.currentTarget.style.transform = 'scale(0.97)'
              }}
              onMouseUp={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
              }}
              onMouseEnter={(e) => {
                if (!isSelected) {
                  e.currentTarget.style.borderColor = Q.BORDER_HOVER
                  e.currentTarget.style.background = Q.HOVER_BG
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'scale(1)'
                if (!isSelected) {
                  e.currentTarget.style.borderColor = Q.BORDER
                  e.currentTarget.style.background = Q.BG_OPTION
                }
              }}
            >
              <span
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 8,
                  background: isSelected
                    ? `linear-gradient(135deg, ${Q.BRAND} 0%, ${Q.BRAND_DEEP} 100%)`
                    : Q.LETTER_BG,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: tokens.typography.fontSize.sm,
                  fontWeight: tokens.typography.fontWeight.bold,
                  color: isSelected ? '#fff' : Q.LETTER_COLOR,
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
          padding: '12px 16px',
          minHeight: 44,
          borderRadius: 8,
          border: 'none',
          background: 'transparent',
          color: Q.TEXT_SECONDARY,
          fontSize: tokens.typography.fontSize.sm,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          transition: 'color 0.2s',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = Q.TEXT_PRIMARY }}
        onMouseLeave={(e) => { e.currentTarget.style.color = Q.TEXT_SECONDARY }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="15 18 9 12 15 6" />
        </svg>
        {tr('quizBack')}
      </button>
    </div>
  )
}
