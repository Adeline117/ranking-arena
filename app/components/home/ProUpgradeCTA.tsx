'use client'

import { tokens } from '@/lib/design-tokens'
import { Box, Text } from '../base'

interface ProUpgradeCTAProps {
  language: string
  t: (key: string) => string
  freeLimit: number
  onUpgrade: () => void
}

export default function ProUpgradeCTA({
  language: _language,
  t,
  freeLimit,
  onUpgrade,
}: ProUpgradeCTAProps) {
  return (
    <Box
      style={{
        marginTop: tokens.spacing[4],
        padding: `${tokens.spacing[5]} ${tokens.spacing[6]}`,
        display: 'flex',
        alignItems: 'center',
        gap: tokens.spacing[5],
        background: 'linear-gradient(135deg, var(--color-bg-secondary) 0%, var(--color-pro-glow, rgba(167,139,250,0.15)) 100%)',
        borderRadius: tokens.radius.xl,
        border: '1px solid var(--color-pro-border, rgba(167,139,250,0.3))',
      }}
    >
      <svg width={32} height={32} viewBox="0 0 24 24" fill="var(--color-pro-gradient-start, #a78bfa)" style={{ flexShrink: 0 }}>
        <path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z" />
      </svg>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Text size="md" weight="bold" style={{ color: 'var(--color-text-primary)', marginBottom: 4 }}>
          {t('upgradeProViewAll')}
        </Text>
        <Text size="sm" style={{ color: 'var(--color-text-tertiary)', lineHeight: 1.5 }}>
          {t('showingTopFreeLimit').replace('{limit}', String(freeLimit))}
        </Text>
      </Box>
      <button
        className="pro-feature-teaser-cta"
        onClick={onUpgrade}
        style={{ flexShrink: 0 }}
      >
        {t('upgradeProFull')}
      </button>
    </Box>
  )
}
