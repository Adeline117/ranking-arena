'use client'

import React, { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Box } from '@/app/components/base'
import { useQuizStore } from '@/lib/stores/quizStore'
import { type Language, translations, loadTranslations, onTranslationsReady } from '@/lib/i18n'
import { PERSONALITY_TYPES, QUIZ_QUESTIONS } from './components/quiz-data'
import { calculateResult } from './components/scoring'
import { getCsrfHeaders } from '@/lib/api/client'
import StartStep from './components/StartStep'
import QuestionStep from './components/QuestionStep'
import ProgressBar from './components/ProgressBar'
const CalculatingStep = lazy(() => import('./components/CalculatingStep'))
import './quiz.css'

const TOTAL_QUESTIONS = QUIZ_QUESTIONS.length

type Step = 'start' | 'questions' | 'calculating'

export default function QuizClient() {
  const router = useRouter()
  // Quiz always starts in English, independent of global language
  const [quizLang, setQuizLang] = useState<Language>('en')
  // Bump to force re-render when async English translations finish loading
  const [, setTxnBump] = useState(0)
  useEffect(() => {
    return onTranslationsReady(() => setTxnBump((v) => v + 1))
  }, [])
  const t = useCallback(
    (key: string): string => {
      const k = key as keyof typeof translations.en
      return translations[quizLang][k] ?? translations.en[k] ?? key
    },
    [quizLang]
  )
  const { answers, setAnswer, setResult, reset } = useQuizStore()
  const [mounted, setMounted] = useState(false)
  const hasExistingAnswers = Object.keys(useQuizStore.getState().answers).length > 0
  const [step, setStep] = useState<Step>(hasExistingAnswers ? 'questions' : 'start')
  const [stepAnnouncement, setStepAnnouncement] = useState('')
  const questionsTopRef = useRef<HTMLDivElement>(null)

  // Focus management: when transitioning to 'questions', focus the progress bar area
  useEffect(() => {
    if (step === 'questions' && questionsTopRef.current) {
      // Small delay to allow DOM to render
      requestAnimationFrame(() => {
        questionsTopRef.current?.focus()
      })
      setStepAnnouncement(t('quizTitle') !== 'quizTitle' ? t('quizTitle') : 'Quiz questions')
    } else if (step === 'calculating') {
      setStepAnnouncement(
        t('quizCalculating') !== 'quizCalculating'
          ? t('quizCalculating')
          : 'Calculating your results'
      )
    }
  }, [step, t])

  useEffect(() => {
    setMounted(true)
    // Only reset if quiz was previously completed (has result); preserve in-progress answers
    if (useQuizStore.getState().result) reset()
    document.body.style.overflow = ''
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const answeredCount = useMemo(
    () => (mounted ? Object.keys(answers).length : 0),
    [answers, mounted]
  )

  const handleStart = useCallback(() => {
    setStep('questions')
  }, [])

  const prefersReducedMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mounted] // re-evaluate once mounted
  )

  const handleSelectOption = useCallback(
    (questionId: number, optionId: string) => {
      setAnswer(questionId, optionId)
      // Auto-scroll to next question after short delay
      const currentIdx = QUIZ_QUESTIONS.findIndex((q) => q.id === questionId)
      if (currentIdx < QUIZ_QUESTIONS.length - 1) {
        const nextId = QUIZ_QUESTIONS[currentIdx + 1].id
        const scrollBehavior = prefersReducedMotion ? 'auto' : 'smooth'
        setTimeout(
          () => {
            const el = document.getElementById(`quiz-q-${nextId}`)
            if (el) el.scrollIntoView({ behavior: scrollBehavior, block: 'nearest' })
          },
          prefersReducedMotion ? 0 : 300
        )
      }
    },
    [setAnswer, prefersReducedMotion]
  )

  const [revealFlash, setRevealFlash] = useState(false)

  const handleCalculationDone = useCallback(() => {
    // Defense-in-depth: do not calculate if quiz is incomplete
    if (Object.keys(answers).length < TOTAL_QUESTIONS) {
      console.error(
        `[Quiz] Incomplete answers (${Object.keys(answers).length}/${TOTAL_QUESTIONS}), aborting calculation`
      )
      return
    }
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
      }).catch(() => {
        /* non-critical analytics */
      })
    } catch {
      // ignore
    }
    // Flash reveal effect then navigate
    setRevealFlash(true)
    // Navigate to result page — include secondary type and type breakdown percents
    const percentsParam = PERSONALITY_TYPES.map((pt) => result.allTypePercents[pt.id] ?? 0).join(
      ','
    )
    setTimeout(() => {
      router.push(
        `/quiz/result?type=${result.primaryType}&match=${result.matchPercent}&secondary=${result.secondaryType}&percents=${percentsParam}`
      )
    }, 300)
  }, [answers, setResult, router])

  const handleSubmit = useCallback(() => {
    setStep('calculating')
  }, [])

  const handleToggleLanguage = useCallback(() => {
    const newLang = quizLang === 'en' ? 'zh' : 'en'
    if (newLang !== 'en') {
      loadTranslations(newLang).then(() => setQuizLang(newLang))
    } else {
      setQuizLang(newLang)
    }
  }, [quizLang])

  // Before hydration: show the start page content (not a spinner)
  // so mobile users see real content even if JS is slow to load
  if (!mounted) {
    return (
      <div className="quiz-start-wrapper">
        <div className="quiz-start-card">
          <StartStep
            tr={(key: string) =>
              key === 'quizTitle'
                ? 'Trading Personality Test'
                : key === 'quizSubtitle'
                  ? 'Answer 30 fun questions to discover your trading alter ego, get matched with a legendary trader, and find Arena traders who trade just like you.'
                  : key === 'quizStartBtn'
                    ? 'Start Test'
                    : key === 'quizBadge12Types'
                      ? '12 Personalities'
                      : key === 'quizBadge5Min'
                        ? '~5 min'
                        : key
            }
            onStart={() => {}}
          />
        </div>
      </div>
    )
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
      aria-label={
        quizLang === 'en'
          ? 'Switch to Chinese / \u5207\u6362\u5230\u4E2D\u6587'
          : 'Switch to English / \u5207\u6362\u5230\u82F1\u6587'
      }
    >
      {quizLang === 'en' ? '\u4E2D\u6587' : 'EN'}
    </button>
  )

  const allAnswered = answeredCount === TOTAL_QUESTIONS

  // Start screen
  if (step === 'start') {
    return (
      <div className="quiz-start-wrapper">
        <div className="quiz-start-card">
          {/* Language toggle */}
          <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 2 }}>
            {langToggleButton}
          </div>
          <StartStep tr={t} onStart={handleStart} />
        </div>
      </div>
    )
  }

  // Calculating screen
  if (step === 'calculating') {
    return (
      <div className="quiz-start-wrapper">
        {/* Reveal flash overlay */}
        {revealFlash && (
          <div
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 50,
              pointerEvents: 'none',
              background:
                'radial-gradient(ellipse at center, var(--color-brand-15, rgba(99,102,241,0.15)) 0%, transparent 70%)',
              animation: 'quizRevealFlash 0.4s ease-out forwards',
            }}
          />
        )}
        <div className="quiz-start-card" style={{ position: 'relative' }}>
          {/* Language toggle */}
          <div style={{ position: 'absolute', top: 14, right: 14, zIndex: 2 }}>
            {langToggleButton}
          </div>
          <Suspense
            fallback={
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  minHeight: 260,
                }}
              >
                <div
                  role="status"
                  aria-label="Loading"
                  style={{
                    width: 40,
                    height: 40,
                    border: '3px solid var(--color-bg-tertiary)',
                    borderTopColor: 'var(--color-brand)',
                    borderRadius: '50%',
                    animation: 'spin 1s linear infinite',
                  }}
                />
              </div>
            }
          >
            <CalculatingStep tr={t} onDone={handleCalculationDone} />
          </Suspense>
        </div>
      </div>
    )
  }

  // Questions — scrollable flow
  return (
    <Box
      style={
        {
          minHeight: '80vh',
          padding: 20,
          paddingBottom: 80,
          touchAction: 'auto',
          WebkitOverflowScrolling: 'touch',
        } as React.CSSProperties
      }
    >
      {/* Screen reader announcement for step transitions */}
      <div
        aria-live="polite"
        aria-atomic="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0,0,0,0)',
          whiteSpace: 'nowrap',
        }}
      >
        {stepAnnouncement}
      </div>
      <div style={{ maxWidth: 'min(640px, 90vw)', width: '100%', margin: '0 auto' }}>
        {/* Sticky progress bar at top with language toggle */}
        <div
          ref={questionsTopRef}
          tabIndex={-1}
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 10,
            background: 'var(--color-bg-primary)',
            padding: '10px 0',
            borderBottom: '1px solid var(--glass-border-light)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            outline: 'none',
          }}
        >
          <div style={{ flex: 1 }}>
            <ProgressBar
              answered={answeredCount}
              total={TOTAL_QUESTIONS}
              questionIds={QUIZ_QUESTIONS.map((q) => q.id)}
              answeredIds={new Set(Object.keys(answers).map(Number))}
            />
          </div>
          {langToggleButton}
        </div>

        {/* All questions rendered */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
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

        {/* Submit button */}
        <div
          style={{
            position: 'sticky',
            bottom: 0,
            zIndex: 10,
            background: 'var(--color-bg-primary)',
            padding: '16px 0',
            paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
            marginTop: 16,
          }}
        >
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!allAnswered}
            className="quiz-submit-btn"
            data-ready={allAnswered ? 'true' : 'false'}
          >
            {allAnswered
              ? t('quizSeeResults')
              : `${TOTAL_QUESTIONS - answeredCount} ${t('quizLeft') !== 'quizLeft' ? t('quizLeft') : 'left'}`}
          </button>
        </div>
      </div>
    </Box>
  )
}
