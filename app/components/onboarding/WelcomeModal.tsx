'use client'

import { useState, useEffect, useCallback } from 'react'
import { tokens } from '@/lib/design-tokens'

const STORAGE_KEY = 'onboarding_complete'

interface Step {
  title: string
  description: string
  cta: string
}

const STEPS: Step[] = [
  {
    title: 'Welcome to Arena',
    description: 'Browse rankings of 34,000+ traders across 28 exchanges',
    cta: 'Explore Rankings \u2192',
  },
  {
    title: 'Follow Top Traders',
    description: 'Follow traders to track their performance and get notifications',
    cta: 'Next \u2192',
  },
  {
    title: 'Go Pro for Deep Insights',
    description: 'Unlock advanced analytics, alerts, and trader comparison',
    cta: 'Get Started',
  },
]

export default function WelcomeModal() {
  const [visible, setVisible] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)

  useEffect(() => {
    try {
      if (!localStorage.getItem(STORAGE_KEY)) {
        setVisible(true)
      }
    } catch {
      // localStorage unavailable (SSR, private browsing)
    }
  }, [])

  const handleClose = useCallback(() => {
    try {
      localStorage.setItem(STORAGE_KEY, '1')
    } catch {
      // ignore
    }
    setVisible(false)
  }, [])

  const handleNext = useCallback(() => {
    if (currentStep < STEPS.length - 1) {
      setCurrentStep(prev => prev + 1)
    } else {
      handleClose()
    }
  }, [currentStep, handleClose])

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep(prev => prev - 1)
    }
  }, [currentStep])

  // Escape key closes modal
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible, handleClose])

  // Scroll lock when modal is open
  useEffect(() => {
    if (visible) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [visible])

  if (!visible) return null

  const step = STEPS[currentStep]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Arena"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: tokens.zIndex.modal,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.6)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
      onClick={handleClose}
    >
      <div
        style={{
          maxWidth: 400,
          width: '90%',
          background: 'var(--color-bg-secondary, #1a1a2e)',
          border: '1px solid var(--color-border-primary, rgba(255,255,255,0.1))',
          borderRadius: 16,
          padding: '32px 28px 24px',
          boxShadow: '0 24px 80px rgba(0,0,0,0.5)',
          position: 'relative',
        }}
        onClick={e => e.stopPropagation()}
      >
        {/* Close button — 44px touch target */}
        <button
          onClick={handleClose}
          aria-label="Close"
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            background: 'none',
            border: 'none',
            color: 'var(--color-text-tertiary, #888)',
            fontSize: 20,
            cursor: 'pointer',
            lineHeight: 1,
            width: 44,
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {'\u2715'}
        </button>

        {/* Step content */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h2
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: 'var(--color-text-primary, #fff)',
              marginBottom: 10,
              marginTop: 0,
            }}
          >
            {step.title}
          </h2>
          <p
            style={{
              fontSize: 15,
              color: 'var(--color-text-secondary, #aaa)',
              lineHeight: 1.5,
              margin: 0,
            }}
          >
            {step.description}
          </p>
        </div>

        {/* Navigation buttons — min 44px touch targets */}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          {currentStep > 0 && (
            <button
              onClick={handleBack}
              style={{
                padding: '12px 20px',
                borderRadius: 10,
                border: '1px solid var(--color-border-primary, rgba(255,255,255,0.15))',
                background: 'transparent',
                color: 'var(--color-text-secondary, #aaa)',
                fontSize: 14,
                fontWeight: 600,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              {'\u2190'} Back
            </button>
          )}
          <button
            onClick={handleNext}
            style={{
              padding: '12px 24px',
              borderRadius: 10,
              border: 'none',
              background: 'var(--color-accent-primary, #8B6FA8)',
              color: '#fff',
              fontSize: 14,
              fontWeight: 600,
              cursor: 'pointer',
              flex: currentStep > 0 ? undefined : 1,
              maxWidth: 240,
              minHeight: 44,
            }}
          >
            {step.cta}
          </button>
        </div>

        {/* Step indicators (dots) */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: 8,
            marginTop: 20,
          }}
        >
          {STEPS.map((_, i) => (
            <div
              key={i}
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background:
                  i === currentStep
                    ? 'var(--color-accent-primary, #8B6FA8)'
                    : 'var(--color-border-primary, rgba(255,255,255,0.2))',
                transition: 'background 0.2s ease',
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
