'use client'

import { useState, useCallback, useEffect } from 'react'
import ModalOverlay from '@/app/components/ui/ModalOverlay'
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
    description: 'Browse trader rankings across live CEX, DEX, and on-chain source boards',
    cta: 'Explore Rankings →',
  },
  {
    title: 'Follow Top Traders',
    description: 'Follow traders to track their performance and get notifications',
    cta: 'Next →',
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
      setCurrentStep((prev) => prev + 1)
    } else {
      handleClose()
    }
  }, [currentStep, handleClose])

  const handleBack = useCallback(() => {
    if (currentStep > 0) {
      setCurrentStep((prev) => prev - 1)
    }
  }, [currentStep])

  const step = STEPS[currentStep]

  return (
    <ModalOverlay
      open={visible}
      onClose={handleClose}
      label="Welcome to Arena"
      maxWidth={400}
      backdrop="heavy"
    >
      <div style={{ padding: '32px 28px 24px', position: 'relative' }}>
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
            color: 'var(--color-text-tertiary)',
            fontSize: tokens.typography.fontSize.xl,
            cursor: 'pointer',
            lineHeight: 1,
            width: 44,
            height: 44,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {'✕'}
        </button>

        {/* Step content */}
        <div style={{ textAlign: 'center', marginBottom: 24 }}>
          <h2
            style={{
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
              fontSize: 22,
              fontWeight: tokens.typography.fontWeight.bold,
              color: 'var(--color-text-primary)',
              marginBottom: 10,
              marginTop: 0,
            }}
          >
            {step.title}
          </h2>
          <p
            style={{
              // eslint-disable-next-line no-restricted-syntax -- off-scale by design (micro label / skeleton)
              fontSize: 15,
              color: 'var(--color-text-secondary)',
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
                borderRadius: tokens.radius.md,
                border: '1px solid var(--color-border-primary, rgba(255,255,255,0.15))',
                background: 'transparent',
                color: 'var(--color-text-secondary)',
                fontSize: tokens.typography.fontSize.base,
                fontWeight: tokens.typography.fontWeight.semibold,
                cursor: 'pointer',
                minHeight: 44,
              }}
            >
              {'←'} Back
            </button>
          )}
          <button
            onClick={handleNext}
            style={{
              padding: '12px 24px',
              borderRadius: tokens.radius.md,
              border: 'none',
              background: 'var(--color-accent-primary)',
              color: tokens.colors.white,
              fontSize: tokens.typography.fontSize.base,
              fontWeight: tokens.typography.fontWeight.semibold,
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
                    ? 'var(--color-accent-primary)'
                    : 'var(--color-border-primary, rgba(255,255,255,0.2))',
                transition: 'background 0.2s ease',
              }}
            />
          ))}
        </div>
      </div>
    </ModalOverlay>
  )
}
