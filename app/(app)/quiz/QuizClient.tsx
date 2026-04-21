'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { useQuizStore } from '@/lib/stores/quizStore'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { QUIZ_QUESTIONS } from './components/quiz-data'
import { calculateResult } from './components/scoring'
import StartStep from './components/StartStep'
import QuestionStep from './components/QuestionStep'
import ProgressBar from './components/ProgressBar'
import CalculatingStep from './components/CalculatingStep'

const TOTAL_QUESTIONS = QUIZ_QUESTIONS.length // 15

export default function QuizClient() {
  const router = useRouter()
  const { t } = useLanguage()
  const { currentQuestion, answers, setAnswer, goToQuestion, goBack, setResult, reset } = useQuizStore()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
    // Reset quiz state when mounting fresh
    reset()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = useCallback(() => {
    goToQuestion(1)
  }, [goToQuestion])

  const handleSelectOption = useCallback(
    (optionId: string) => {
      const qId = currentQuestion
      setAnswer(qId, optionId)
      // Auto-advance after 300ms
      setTimeout(() => {
        if (qId < TOTAL_QUESTIONS) {
          goToQuestion(qId + 1)
        } else {
          // Last question — go to calculating
          goToQuestion(TOTAL_QUESTIONS + 1)
        }
      }, 300)
    },
    [currentQuestion, setAnswer, goToQuestion]
  )

  const handleBack = useCallback(() => {
    if (currentQuestion > 1) {
      goToQuestion(currentQuestion - 1)
    } else {
      goToQuestion(0) // Back to start
    }
  }, [currentQuestion, goToQuestion])

  const handleCalculationDone = useCallback(() => {
    const result = calculateResult(answers)
    setResult(result)
    // Save result (fire-and-forget)
    try {
      const sessionId =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : Math.random().toString(36).slice(2)
      fetch('/api/quiz/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          primaryType: result.primaryType,
          secondaryType: result.secondaryType,
          matchPercent: result.matchPercent,
          scores: result.scores,
          answers,
        }),
      }).catch(() => {}) // swallow errors — this is optional analytics
    } catch {
      // ignore
    }
    // Navigate to result page
    router.push(`/quiz/result?type=${result.primaryType}&match=${result.matchPercent}`)
  }, [answers, setResult, router])

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (currentQuestion === 0 && e.key === 'Enter') {
        e.preventDefault()
        handleStart()
      } else if (currentQuestion >= 1 && currentQuestion <= TOTAL_QUESTIONS && e.key === 'Escape') {
        e.preventDefault()
        handleBack()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentQuestion, handleStart, handleBack])

  if (!mounted) {
    return (
      <Box
        style={{
          minHeight: '100vh',
          background: tokens.colors.bg.primary,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            border: '3px solid var(--color-accent-primary-20)',
            borderTopColor: 'var(--color-brand)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      </Box>
    )
  }

  const isQuestion = currentQuestion >= 1 && currentQuestion <= TOTAL_QUESTIONS
  const isCalculating = currentQuestion === TOTAL_QUESTIONS + 1
  const currentQ = isQuestion ? QUIZ_QUESTIONS[currentQuestion - 1] : null

  return (
    <Box
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Background */}
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: tokens.colors.bg.primary,
          zIndex: -1,
        }}
      />

      {/* Card */}
      <Box
        style={{
          maxWidth: 520,
          width: '100%',
          background: 'var(--color-backdrop-heavy)',
          border: '1px solid var(--color-accent-primary-15)',
          borderRadius: 24,
          padding: 'clamp(24px, 5vw, 40px) clamp(20px, 4vw, 32px)',
          position: 'relative',
          zIndex: 1,
          boxShadow: '0 25px 50px -12px var(--color-overlay-dark), 0 0 80px var(--color-notification-unread)',
        }}
      >
        {/* Progress bar (visible during questions) */}
        {isQuestion && (
          <div style={{ marginBottom: 24 }}>
            <ProgressBar current={currentQuestion} total={TOTAL_QUESTIONS} />
          </div>
        )}

        {/* Steps */}
        {currentQuestion === 0 && <StartStep tr={t} onStart={handleStart} />}

        {isQuestion && currentQ && (
          <QuestionStep
            key={currentQ.id}
            question={currentQ}
            selectedOption={answers[currentQ.id]}
            tr={t}
            onSelect={handleSelectOption}
            onBack={handleBack}
          />
        )}

        {isCalculating && <CalculatingStep tr={t} onDone={handleCalculationDone} />}
      </Box>
    </Box>
  )
}
