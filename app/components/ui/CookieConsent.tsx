'use client'

import { useState, useEffect } from 'react'
import { tokens } from '@/lib/design-tokens'
import {
  getConsentManager,
  hasConsented,
  acceptAllConsent,
  acceptNecessaryOnlyConsent,
  setConsent,
  type ConsentState,
  type ConsentCategory,
} from '@/lib/compliance/consent'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'

// ============================================
// Styles
// ============================================

const styles = {
  overlay: {
    position: 'fixed' as const,
    bottom: 0,
    left: 0,
    right: 0,
    zIndex: tokens.zIndex.toast,
    padding: '16px',
    background: tokens.glass.bg.heavy,
    backdropFilter: 'blur(10px)',
  },
  container: {
    maxWidth: '1200px',
    margin: '0 auto',
    padding: '20px 24px',
    background: tokens.colors.bg.secondary,
    borderRadius: tokens.radius.lg,
    border: `1px solid ${tokens.colors.border.primary}`,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '16px',
    gap: '16px',
  },
  title: {
    fontSize: '18px',
    fontWeight: 600,
    color: tokens.colors.text.primary,
    margin: 0,
  },
  description: {
    fontSize: '14px',
    color: tokens.colors.text.secondary,
    lineHeight: 1.6,
    margin: '8px 0 0 0',
  },
  buttonGroup: {
    display: 'flex',
    gap: '12px',
    flexWrap: 'wrap' as const,
  },
  button: {
    padding: '10px 20px',
    borderRadius: tokens.radius.md,
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
    border: 'none',
  },
  primaryButton: {
    background: tokens.colors.accent.brand,
    color: tokens.colors.white,
  },
  secondaryButton: {
    background: 'transparent',
    color: tokens.colors.text.secondary,
    border: `1px solid ${tokens.colors.border.secondary}`,
  },
  linkButton: {
    background: 'transparent',
    color: tokens.colors.text.tertiary,
    padding: '10px 12px',
    textDecoration: 'underline',
  },
  settingsContainer: {
    marginTop: '16px',
    paddingTop: '16px',
    borderTop: `1px solid ${tokens.colors.border.primary}`,
  },
  categoryItem: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    padding: '12px 0',
    borderBottom: `1px solid ${tokens.colors.border.primary}`,
  },
  categoryInfo: {
    flex: 1,
    paddingRight: '16px',
  },
  categoryName: {
    fontSize: '14px',
    fontWeight: 500,
    color: tokens.colors.text.primary,
    marginBottom: '4px',
  },
  categoryDescription: {
    fontSize: tokens.typography.fontSize.sm,
    color: tokens.colors.text.tertiary,
    lineHeight: 1.5,
  },
  toggle: {
    position: 'relative' as const,
    width: '44px',
    height: '24px',
    background: tokens.colors.bg.tertiary,
    borderRadius: tokens.radius.lg,
    cursor: 'pointer',
    transition: 'background 0.2s ease',
    flexShrink: 0,
  },
  toggleActive: {
    background: tokens.colors.accent.brand,
  },
  toggleDisabled: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
  toggleKnob: {
    position: 'absolute' as const,
    top: '2px',
    left: '2px',
    width: '20px',
    height: '20px',
    background: tokens.colors.white,
    borderRadius: '50%',
    transition: 'transform 0.2s ease',
  },
  toggleKnobActive: {
    transform: 'translateX(20px)',
  },
}

// ============================================
// Toggle Component
// ============================================

function Toggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange?: (checked: boolean) => void
}) {
  return (
    <div
      style={{
        ...styles.toggle,
        ...(checked ? styles.toggleActive : {}),
        ...(disabled ? styles.toggleDisabled : {}),
      }}
      onClick={() => !disabled && onChange?.(!checked)}
      role="switch"
      aria-checked={checked}
      aria-disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (!disabled) {
            onChange?.(!checked)
          }
        }
      }}
    >
      <div
        style={{
          ...styles.toggleKnob,
          ...(checked ? styles.toggleKnobActive : {}),
        }}
      />
    </div>
  )
}

// ============================================
// Cookie Consent Component
// ============================================

export function CookieConsent() {
  const { t } = useLanguage()
  const [visible, setVisible] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [preferences, setPreferences] = useState<Partial<ConsentState>>({
    analytics: false,
    preferences: false,
    marketing: false,
  })

  const cookieCategories = [
    { id: 'necessary' as ConsentCategory, name: t('cookieNecessary'), description: t('cookieNecessaryDesc'), required: true },
    { id: 'analytics' as ConsentCategory, name: t('cookieAnalytics'), description: t('cookieAnalyticsDesc'), required: false },
    { id: 'preferences' as ConsentCategory, name: t('cookiePreferences'), description: t('cookiePreferencesDesc'), required: false },
    { id: 'marketing' as ConsentCategory, name: t('cookieMarketing'), description: t('cookieMarketingDesc'), required: false },
  ]

  useEffect(() => {
    const consented = hasConsented()
    setVisible(!consented)

    if (consented) {
      const state = getConsentManager().getState()
      setPreferences({
        analytics: state.analytics,
        preferences: state.preferences,
        marketing: state.marketing,
      })
    }
  }, [])

  const handleAcceptAll = () => {
    acceptAllConsent()
    setVisible(false)
  }

  const handleAcceptNecessary = () => {
    acceptNecessaryOnlyConsent()
    setVisible(false)
  }

  const handleSavePreferences = () => {
    setConsent({
      analytics: preferences.analytics || false,
      preferences: preferences.preferences || false,
      marketing: preferences.marketing || false,
    })
    setVisible(false)
  }

  const handleToggleCategory = (category: ConsentCategory) => {
    if (category === 'necessary') return

    setPreferences(prev => ({
      ...prev,
      [category]: !prev[category],
    }))
  }

  if (!visible) return null

  return (
    <div style={styles.overlay}>
      <div style={styles.container}>
        <div style={styles.header}>
          <div>
            <h3 style={styles.title}>{t('cookieSettings')}</h3>
            <p style={styles.description}>
              {t('cookieDescription')}
            </p>
          </div>

          {!showSettings && (
            <div style={styles.buttonGroup}>
              <button
                style={{ ...styles.button, ...styles.primaryButton }}
                onClick={handleAcceptAll}
              >
                {t('acceptAll')}
              </button>
              <button
                style={{ ...styles.button, ...styles.secondaryButton }}
                onClick={handleAcceptNecessary}
              >
                {t('necessaryOnly')}
              </button>
              <button
                style={{ ...styles.button, ...styles.linkButton }}
                onClick={() => setShowSettings(true)}
              >
                {t('customizeSettings')}
              </button>
            </div>
          )}
        </div>

        {showSettings && (
          <div style={styles.settingsContainer}>
            {cookieCategories.map((category) => (
              <div key={category.id} style={styles.categoryItem}>
                <div style={styles.categoryInfo}>
                  <div style={styles.categoryName}>{category.name}</div>
                  <div style={styles.categoryDescription}>{category.description}</div>
                </div>
                <Toggle
                  checked={category.required || preferences[category.id] || false}
                  disabled={category.required}
                  onChange={() => handleToggleCategory(category.id)}
                />
              </div>
            ))}

            <div style={{ ...styles.buttonGroup, marginTop: '16px' }}>
              <button
                style={{ ...styles.button, ...styles.primaryButton }}
                onClick={handleSavePreferences}
              >
                {t('saveSettings')}
              </button>
              <button
                style={{ ...styles.button, ...styles.secondaryButton }}
                onClick={handleAcceptAll}
              >
                {t('acceptAll')}
              </button>
              <button
                style={{ ...styles.button, ...styles.linkButton }}
                onClick={() => setShowSettings(false)}
              >
                {t('back')}
              </button>
            </div>
          </div>
        )}

        <div style={{ marginTop: '12px', fontSize: tokens.typography.fontSize.sm, color: tokens.colors.text.tertiary }}>
          {t('learnMorePrivacy')}{' '}
          <a href="/privacy" style={{ color: tokens.colors.accent.brandHover }}>{t('privacyPolicy')}</a>
          {' '}{t('andWord')}{' '}
          <a href="/terms" style={{ color: tokens.colors.accent.brandHover }}>{t('termsOfService')}</a>
        </div>
      </div>
    </div>
  )
}

export default CookieConsent
