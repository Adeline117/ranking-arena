'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import { lightTokens, darkTokens } from '@/lib/theme-tokens'
import type { Language } from '@/lib/i18n'
import type { OnboardingTheme } from './types'

interface WelcomeStepProps {
  theme: OnboardingTheme
  language: Language
  currentTheme: 'dark' | 'light'
  tr: (key: string) => string
  onLanguageChange: (lang: Language) => void
  onThemeChange: (theme: 'dark' | 'light') => void
  onContinue: () => void
}

export default function WelcomeStep({ theme, language, currentTheme, tr, onLanguageChange, onThemeChange, onContinue }: WelcomeStepProps) {
  return (
    <div key="welcome" className="step-content">
      <Box style={{ textAlign: 'center', marginBottom: 32 }}>
        <Text size="3xl" weight="black" style={{
          marginBottom: 8,
          background: 'linear-gradient(135deg, var(--color-brand) 0%, var(--color-brand-accent) 100%)',
          WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
        }}>
          Arena
        </Text>
        <Text size="xl" weight="bold" style={{ marginBottom: 8, color: theme.textPrimary }}>
          {tr('onboardingTitle')}
        </Text>
        <Text style={{ color: theme.textSecondary }}>
          {tr('onboardingSubtitle')}
        </Text>
      </Box>

      {/* Language */}
      <Box style={{ marginBottom: 24 }}>
        <Text size="sm" weight="bold" style={{ marginBottom: 12, display: 'block', color: theme.textSecondary }}>
          {tr('selectLanguage')}
        </Text>
        <Box style={{ display: 'flex', gap: 12 }}>
          {(['zh', 'en'] as Language[]).map(lang => (
            <Box key={lang} className={`option-card ${language === lang ? 'selected' : ''}`}
              onClick={() => onLanguageChange(lang)}
              style={{
                flex: 1, padding: '16px 20px', borderRadius: 14,
                border: `1px solid ${language === lang ? theme.selectedBorder : theme.optionBorder}`,
                background: language === lang ? theme.selectedBg : theme.optionBg, textAlign: 'center',
              }}>
              <Text size="lg" weight={language === lang ? 'bold' : 'medium'}
                style={{ color: language === lang ? 'var(--color-brand-accent)' : theme.textSecondary }}>
                {lang === 'zh' ? tr('chineseLabel') : tr('englishLabel')}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      {/* Theme */}
      <Box style={{ marginBottom: 32 }}>
        <Text size="sm" weight="bold" style={{ marginBottom: 12, display: 'block', color: theme.textSecondary }}>
          {tr('selectTheme')}
        </Text>
        <Box style={{ display: 'flex', gap: 12 }}>
          {(['dark', 'light'] as ('dark' | 'light')[]).map(t => (
            <Box key={t} className={`option-card ${currentTheme === t ? 'selected' : ''}`}
              onClick={() => onThemeChange(t)}
              style={{
                flex: 1, padding: '16px 20px', borderRadius: 14,
                border: `1px solid ${currentTheme === t ? theme.selectedBorder : theme.optionBorder}`,
                background: currentTheme === t ? theme.selectedBg : theme.optionBg, textAlign: 'center',
              }}>
              <Box style={{
                width: 32, height: 32, margin: '0 auto 8px', borderRadius: '50%',
                background: t === 'dark' ? darkTokens.colors.bg.secondary : lightTokens.colors.bg.secondary,
                border: '2px solid var(--color-brand)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {t === 'dark' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-accent)" strokeWidth="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" /></svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand)" strokeWidth="2">
                    <circle cx="12" cy="12" r="5" />
                    <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                    <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
                  </svg>
                )}
              </Box>
              <Text size="sm" weight={currentTheme === t ? 'bold' : 'medium'}
                style={{ color: currentTheme === t ? (t === 'dark' ? 'var(--color-brand-accent)' : 'var(--color-brand)') : theme.textSecondary }}>
                {t === 'dark' ? tr('darkMode') : tr('lightMode')}
              </Text>
            </Box>
          ))}
        </Box>
      </Box>

      <button className="continue-btn" onClick={onContinue} style={{
        width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
        background: theme.brandGradient,
        color: tokens.colors.white, fontWeight: 700, fontSize: 16, cursor: 'pointer',
      }}>
        {tr('continueButton')}
      </button>
    </div>
  )
}
