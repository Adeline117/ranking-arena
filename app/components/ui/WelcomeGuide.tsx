'use client'

import React, { useState, useEffect, type ReactElement } from 'react'
import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'
import { useLanguage } from '../Providers/LanguageProvider'

const WELCOME_STORAGE_KEY = 'ranking-arena-welcome-seen'

interface WelcomeStep {
  titleKey: string
  descKey: string
  icon: React.ReactNode
}

const WELCOME_STEPS: WelcomeStep[] = [
  {
    titleKey: 'welcomeGuideLeaderboardTitle',
    descKey: 'welcomeGuideLeaderboardDesc',
    icon: <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>,
  },
  {
    titleKey: 'welcomeGuideSearchTitle',
    descKey: 'welcomeGuideSearchDesc',
    icon: <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>,
  },
  {
    titleKey: 'welcomeGuideFollowTitle',
    descKey: 'welcomeGuideFollowDesc',
    icon: <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 1L9 9H1l6 5-2 9 7-5 7 5-2-9 6-5h-8z"/></svg>,
  },
  {
    titleKey: 'welcomeGuideCommunityTitle',
    descKey: 'welcomeGuideCommunityDesc',
    icon: <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
  },
]

export function WelcomeGuide(): ReactElement | null {
  const { t } = useLanguage()
  const [isVisible, setIsVisible] = useState(false)
  const [currentStep, setCurrentStep] = useState(0)

  useEffect(() => {
    if (typeof window === 'undefined') return

    const hasSeenWelcome = localStorage.getItem(WELCOME_STORAGE_KEY)
    if (!hasSeenWelcome) {
      // Delay showing the welcome guide
      const timer = setTimeout(() => {
        setIsVisible(true)
      }, 1500)
      return () => clearTimeout(timer)
    }
  }, [])

  const handleNext = () => {
    if (currentStep < WELCOME_STEPS.length - 1) {
      setCurrentStep(prev => prev + 1)
    } else {
      handleClose()
    }
  }

  const handleSkip = () => {
    handleClose()
  }

  const handleClose = () => {
    setIsVisible(false)
    if (typeof window !== 'undefined') {
      localStorage.setItem(WELCOME_STORAGE_KEY, Date.now().toString())
    }
  }

  if (!isVisible) return null

  const step = WELCOME_STEPS[currentStep]
  const isLastStep = currentStep === WELCOME_STEPS.length - 1

  return (
    <Box
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: tokens.zIndex.modal,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: tokens.spacing[4],
      }}
    >
      {/* Backdrop */}
      <Box
        onClick={handleSkip}
        style={{
          position: 'absolute',
          inset: 0,
          background: 'var(--color-backdrop)',
          backdropFilter: tokens.glass.blur.xs,
          WebkitBackdropFilter: tokens.glass.blur.xs,
        }}
      />

      {/* Modal */}
      <Box
        style={{
          position: 'relative',
          background: tokens.colors.bg.primary,
          borderRadius: tokens.radius.xl,
          padding: tokens.spacing[6],
          maxWidth: 400,
          width: '100%',
          boxShadow: tokens.shadow.xl,
          border: `1px solid ${tokens.colors.border.primary}`,
          animation: 'fadeIn 0.3s ease-out',
        }}
      >
        {/* Progress dots */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'center',
            gap: tokens.spacing[2],
            marginBottom: tokens.spacing[4],
          }}
        >
          {WELCOME_STEPS.map((_, index) => (
            <Box
              key={index}
              style={{
                width: 8,
                height: 8,
                borderRadius: tokens.radius.full,
                background: index === currentStep
                  ? tokens.colors.accent.brand
                  : tokens.colors.bg.tertiary,
                transition: `all ${tokens.transition.base}`,
              }}
            />
          ))}
        </Box>

        {/* Icon */}
        <Box
          style={{
            display: 'flex',
            justifyContent: 'center',
            color: tokens.colors.accent.brand,
            marginBottom: tokens.spacing[4],
          }}
        >
          {step.icon}
        </Box>

        {/* Content */}
        <Text
          size="lg"
          weight="bold"
          style={{
            color: tokens.colors.text.primary,
            textAlign: 'center',
            marginBottom: tokens.spacing[2],
          }}
        >
          {t(step.titleKey)}
        </Text>

        <Text
          size="sm"
          style={{
            color: tokens.colors.text.secondary,
            textAlign: 'center',
            lineHeight: 1.6,
            marginBottom: tokens.spacing[6],
          }}
        >
          {t(step.descKey)}
        </Text>

        {/* Actions */}
        <Box
          style={{
            display: 'flex',
            gap: tokens.spacing[3],
          }}
        >
          <button
            onClick={handleSkip}
            style={{
              flex: 1,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.colors.bg.tertiary,
              color: tokens.colors.text.secondary,
              border: 'none',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              cursor: 'pointer',
            }}
          >
            {t('skip')}
          </button>

          <button
            onClick={handleNext}
            style={{
              flex: 1,
              padding: `${tokens.spacing[3]} ${tokens.spacing[4]}`,
              borderRadius: tokens.radius.lg,
              background: tokens.colors.accent.brand,
              color: tokens.colors.white,
              border: 'none',
              fontSize: tokens.typography.fontSize.sm,
              fontWeight: tokens.typography.fontWeight.semibold,
              cursor: 'pointer',
            }}
          >
            {isLastStep ? t('getStarted') : t('continueButton')}
          </button>
        </Box>
      </Box>
    </Box>
  )
}

/**
 * Reset welcome guide (for testing)
 */
export function resetWelcomeGuide(): void {
  if (typeof window === 'undefined') return
  localStorage.removeItem(WELCOME_STORAGE_KEY)
}

export default WelcomeGuide
