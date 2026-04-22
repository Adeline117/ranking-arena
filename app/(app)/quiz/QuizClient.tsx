'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
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

const TOTAL_QUESTIONS = QUIZ_QUESTIONS.length

type Step = 'start' | 'questions' | 'calculating'

export default function QuizClient() {
  const router = useRouter()
  const { language, t } = useLanguage()
  const { answers, setAnswer, setResult, reset } = useQuizStore()
  const [mounted, setMounted] = useState(false)
  const [txnReady, setTxnReady] = useState(false)
  const [step, setStep] = useState<Step>('start')

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
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const answeredCount = useMemo(
    () => mounted ? Object.keys(answers).length : 0,
    [answers, mounted]
  )

  const handleStart = useCallback(() => {
    setStep('questions')
  }, [])

  const handleSelectOption = useCallback(
    (questionId: number, optionId: string) => {
      setAnswer(questionId, optionId)
      // Auto-scroll to next question after short delay
      const currentIdx = QUIZ_QUESTIONS.findIndex(q => q.id === questionId)
      if (currentIdx < QUIZ_QUESTIONS.length - 1) {
        const nextId = QUIZ_QUESTIONS[currentIdx + 1].id
        setTimeout(() => {
          const el = document.getElementById(`quiz-q-${nextId}`)
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        }, 300)
      }
    },
    [setAnswer]
  )

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

  const handleSubmit = useCallback(() => {
    setStep('calculating')
  }, [])

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
          role="status"
          aria-label="Loading quiz"
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

  const langToggleButton = (
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
  )

  // Start screen
  if (step === 'start') {
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
          {/* Language toggle */}
          <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 1 }}>
            {langToggleButton}
          </div>
          <StartStep tr={t} onStart={handleStart} />
        </Box>
      </Box>
    )
  }

  // Calculating screen
  if (step === 'calculating') {
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
        <Box
          style={{
            maxWidth: 520,
            width: '100%',
            background: 'var(--color-bg-secondary)',
            border: '1px solid var(--glass-border-light)',
            borderRadius: 12,
            padding: 'clamp(20px, 4vw, 32px)',
          }}
        >
          <CalculatingStep tr={t} onDone={handleCalculationDone} />
        </Box>
      </Box>
    )
  }

  // Questions — scrollable flow
  return (
    <Box style={{ minHeight: '80vh', padding: 20, paddingBottom: 80 }}>
      <div style={{ maxWidth: 520, width: '100%', margin: '0 auto' }}>
        {/* Sticky progress bar at top */}
        <div
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            background: 'var(--color-bg-primary)',
            padding: '8px 0',
            borderBottom: '1px solid var(--glass-border-light)',
          }}
        >
          <ProgressBar answered={answeredCount} total={TOTAL_QUESTIONS} />
        </div>

        {/* Language toggle */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          {langToggleButton}
        </div>

        {/* All questions rendered */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          {QUIZ_QUESTIONS.map((q, idx) => (
            <QuestionStep
              key={q.id}
              question={q}
              questionNumber={idx + 1}
              totalQuestions={TOTAL_QUESTIONS}
              selectedOption={answers[q.id]}
              tr={t}
              onSelect={(optionId) => handleSelectOption(q.id, optionId)}
            />
          ))}
        </div>

        {/* Submit button — appears when all answered */}
        {answeredCount === TOTAL_QUESTIONS && (
          <div
            style={{
              position: 'sticky',
              bottom: 64,
              zIndex: 10,
              background: 'var(--color-bg-primary)',
              padding: '16px 0',
              marginTop: 16,
            }}
          >
            <button
              type="button"
              onClick={handleSubmit}
              style={{
                width: '100%',
                padding: '14px 32px',
                borderRadius: 10,
                background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-deep))',
                border: 'none',
                color: '#fff',
                fontSize: 16,
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'transform 0.2s, box-shadow 0.2s',
                boxShadow: '0 4px 16px color-mix(in srgb, var(--color-brand) 30%, transparent)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-1px)'
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'translateY(0)'
              }}
            >
              {t('quizSeeResults')}
            </button>
          </div>
        )}
      </div>
    </Box>
  )
}
