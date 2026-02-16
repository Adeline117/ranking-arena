'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { OnboardingTheme } from './types'

interface CompleteStepProps {
  theme: OnboardingTheme
  tr: (key: string) => string
  onGoRankings: () => void
}

export default function CompleteStep({ theme, tr, onGoRankings }: CompleteStepProps) {
  return (
    <div key="complete" className="step-content" style={{ textAlign: 'center' }}>
      <Box className="celebration-icon" style={{
        width: 80, height: 80, borderRadius: '50%',
        background: 'linear-gradient(135deg, var(--color-accent-primary-30) 0%, var(--color-accent-primary-10) 100%)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        margin: '0 auto 28px', boxShadow: '0 0 40px var(--color-accent-primary-30)',
      }}>
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--color-brand-accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline className="check-animation" points="20 6 9 17 4 12" />
        </svg>
      </Box>
      <Text size="2xl" weight="black" style={{
        marginBottom: 12,
        background: `linear-gradient(135deg, ${theme.textPrimary} 0%, var(--color-brand-accent) 100%)`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
      }}>
        {tr('onboardingDoneTitle')}
      </Text>
      <Text style={{ marginBottom: 36, color: theme.textSecondary }}>
        {tr('onboardingDoneDesc')}
      </Text>

      <button className="continue-btn" onClick={onGoRankings} style={{
        width: '100%', padding: '16px 24px', borderRadius: 14, border: 'none',
        background: theme.brandGradient,
        color: tokens.colors.white, fontWeight: 700, fontSize: 16, cursor: 'pointer',
      }}>
        {tr('onboardingGoRankings')}
      </button>
    </div>
  )
}
