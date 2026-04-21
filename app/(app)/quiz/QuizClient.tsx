'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '@/app/components/base'
import { useQuizStore } from '@/lib/stores/quizStore'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { setLanguage } from '@/lib/i18n'
import { onTranslationsReady } from '@/lib/i18n'
import { QUIZ_QUESTIONS } from './components/quiz-data'
import { calculateResult } from './components/scoring'
import { getCsrfHeaders } from '@/lib/api/client'
import StartStep from './components/StartStep'
import QuestionStep from './components/QuestionStep'
import ProgressBar from './components/ProgressBar'
import CalculatingStep from './components/CalculatingStep'

const TOTAL_QUESTIONS = QUIZ_QUESTIONS.length // 15

export default function QuizClient() {
  const router = useRouter()
  const { language, t } = useLanguage()
  const { currentQuestion, answers, setAnswer, goToQuestion, setResult, reset } = useQuizStore()
  const [mounted, setMounted] = useState(false)
  const [txnReady, setTxnReady] = useState(false)
  const autoAdvanceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setMounted(true)
    // Reset quiz state when mounting fresh
    reset()
    // Wait for translations to be loaded
    const unsub = onTranslationsReady(() => setTxnReady(true))
    // Check if already loaded
    if (t('quizTitle') !== 'quizTitle') setTxnReady(true)
    return () => {
      unsub()
      if (autoAdvanceTimer.current) {
        clearTimeout(autoAdvanceTimer.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const handleStart = useCallback(() => {
    goToQuestion(1)
  }, [goToQuestion])

  const handleSelectOption = useCallback(
    (optionId: string) => {
      const qId = currentQuestion
      setAnswer(qId, optionId)
      // Auto-advance after 300ms
      if (autoAdvanceTimer.current) {
        clearTimeout(autoAdvanceTimer.current)
      }
      autoAdvanceTimer.current = setTimeout(() => {
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
        headers: { 'Content-Type': 'application/json', ...getCsrfHeaders() },
        body: JSON.stringify({
          sessionId,
          primaryType: result.primaryType,
          secondaryType: result.secondaryType,
          matchPercent: result.matchPercent,
          scores: result.scores,
          answers,
        }),
      }).catch(() => { /* non-critical analytics */ }) // eslint-disable-line no-restricted-syntax
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
      } else if (currentQuestion >= 1 && currentQuestion <= TOTAL_QUESTIONS) {
        if (e.key === 'Escape') {
          e.preventDefault()
          handleBack()
        } else {
          // A/B/C/D or 1/2/3/4 to select options
          const currentQ = QUIZ_QUESTIONS[currentQuestion - 1]
          if (currentQ) {
            const keyLower = e.key.toLowerCase()
            const letterIndex = keyLower.charCodeAt(0) - 97 // a=0, b=1, c=2, d=3
            const digitIndex = parseInt(e.key, 10) - 1 // 1=0, 2=1, 3=2, 4=3
            const idx = letterIndex >= 0 && letterIndex < currentQ.options.length
              ? letterIndex
              : digitIndex >= 0 && digitIndex < currentQ.options.length
                ? digitIndex
                : -1
            if (idx >= 0) {
              e.preventDefault()
              handleSelectOption(currentQ.options[idx].id)
            }
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [currentQuestion, handleStart, handleBack, handleSelectOption])

  // Show loading until both mounted AND translations ready
  if (!mounted || !txnReady) {
    return (
      <Box
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '80vh',
          padding: 20,
        }}
      >
        <div
          style={{
            width: 40,
            height: 40,
            border: '3px solid var(--color-accent-primary-08)',
            borderTopColor: 'var(--color-brand)',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
          }}
        />
      </Box>
    )
  }

  const handleToggleLanguage = () => {
    const newLang = language === 'en' ? 'zh' : 'en'
    setLanguage(newLang)
  }

  const isQuestion = currentQuestion >= 1 && currentQuestion <= TOTAL_QUESTIONS
  const isCalculating = currentQuestion === TOTAL_QUESTIONS + 1

  const currentQ = isQuestion ? QUIZ_QUESTIONS[currentQuestion - 1] : null

  return (
    <Box
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '80vh',
        padding: 20,
      }}
    >
      {/* Card */}
      <Box
        style={{
          maxWidth: 520,
          width: '100%',
          background: 'var(--color-bg-secondary)',
          border: '1px solid var(--glass-border-light)',
          borderRadius: 12,
          padding: 'clamp(20px, 4vw, 32px)',
          position: 'relative',
        }}
      >
        {/* Language toggle — top-right of card */}
        <div
          style={{
            position: 'absolute',
            top: 12,
            right: 12,
            zIndex: 1,
          }}
        >
          <button
            type="button"
            onClick={handleToggleLanguage}
            style={{
              padding: '4px 10px',
              borderRadius: 6,
              border: '1px solid var(--glass-border-light)',
              background: 'transparent',
              color: 'var(--color-text-tertiary)',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
            }}
            aria-label="Toggle language"
          >
            {language === 'en' ? '\u4E2D\u6587' : 'EN'}
          </button>
        </div>

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
