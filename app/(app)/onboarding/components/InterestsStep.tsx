'use client'

import { Box, Text } from '@/app/components/base'
import { tokens } from '@/lib/design-tokens'
import type { OnboardingTheme } from './types'

const INTERESTS = [
  { id: 'defi', labelKey: 'defi', icon: '\u2B21' },
  { id: 'cex', labelKey: 'interestCex', icon: '\u25C8' },
  { id: 'quant', labelKey: 'interestQuant', icon: '\u29D7' },
  { id: 'nft', labelKey: 'nft', icon: '\u25C7' },
  { id: 'layer2', labelKey: 'interestLayer2', icon: '\u25EB' },
  { id: 'onchain', labelKey: 'interestOnchain', icon: '\u25CE' },
  { id: 'futures', labelKey: 'futuresTrading', icon: '\u27E1' },
  { id: 'spot', labelKey: 'spotTrading', icon: '\u25C9' },
  { id: 'macro', labelKey: 'interestMacro', icon: '\u25A3' },
  { id: 'meme', labelKey: 'interestMeme', icon: '\u25CA' },
]

interface InterestsStepProps {
  theme: OnboardingTheme
  selectedInterests: string[]
  tr: (key: string) => string
  onToggleInterest: (id: string) => void
  onBack: () => void
  onContinue: () => void
}

export default function InterestsStep({ theme, selectedInterests, tr, onToggleInterest, onBack, onContinue }: InterestsStepProps) {
  return (
    <div key="interests" className="step-content">
      <button onClick={onBack} style={{
        background: 'none', border: 'none', color: theme.textSecondary, cursor: 'pointer',
        fontSize: 13, fontWeight: 600, padding: '4px 0', marginBottom: 12,
        display: 'flex', alignItems: 'center', gap: 4,
      }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
        {tr('back')}
      </button>
      <Text size="2xl" weight="black" style={{
        marginBottom: 8, textAlign: 'center',
        background: `linear-gradient(135deg, ${theme.textPrimary} 0%, var(--color-brand-accent) 100%)`,
        WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent',
      }}>
        {tr('selectInterests')}
      </Text>
      <Text style={{ marginBottom: 28, textAlign: 'center', color: theme.textSecondary }}>
        {tr('selectInterestsDesc')}
      </Text>

      <Box style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 32 }}>
        {INTERESTS.map(interest => {
          const isSelected = selectedInterests.includes(interest.id)
          return (
            <Box key={interest.id} onClick={() => onToggleInterest(interest.id)}
              onKeyDown={(e: React.KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleInterest(interest.id) } }}
              tabIndex={0}
              role="checkbox"
              aria-checked={isSelected}
              className={`interest-card ${isSelected ? 'selected' : ''}`}
              style={{
                padding: '14px 16px', borderRadius: 14,
                border: isSelected ? `1px solid ${theme.selectedBorder}` : `1px solid ${theme.optionBorder}`,
                background: isSelected ? theme.selectedBg : theme.optionBg,
                display: 'flex', alignItems: 'center', gap: 10,
                outline: 'none',
              }}>
              <span style={{ fontSize: 16, opacity: isSelected ? 1 : 0.5, transition: 'opacity 0.2s ease' }}>
                {interest.icon}
              </span>
              <Text size="sm" weight={isSelected ? 'bold' : 'medium'}
                style={{ color: isSelected ? 'var(--color-brand-accent)' : theme.textSecondary }}>
                {tr(interest.labelKey)}
              </Text>
            </Box>
          )
        })}
      </Box>

      <Box style={{ display: 'flex', gap: 14 }}>
        <button className="continue-btn" onClick={onContinue}
          style={{
            flex: 1, padding: '14px 20px', borderRadius: tokens.radius.lg,
            border: `1px solid ${theme.optionBorder}`, background: 'transparent',
            color: theme.textSecondary, fontWeight: 600, fontSize: 16, cursor: 'pointer',
          }}>
          {tr('skip')}
        </button>
        <button className="continue-btn" onClick={onContinue} style={{
          flex: 2, padding: '14px 20px', borderRadius: tokens.radius.lg, border: 'none',
          background: theme.brandGradient,
          color: tokens.colors.white, fontWeight: 700, fontSize: 16, cursor: 'pointer',
        }}>
          {tr('continueButton')}
        </button>
      </Box>
    </div>
  )
}
