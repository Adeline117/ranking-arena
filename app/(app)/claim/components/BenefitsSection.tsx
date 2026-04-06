'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box, Text } from '@/app/components/base'

export function BenefitsSection() {
  const { t } = useLanguage()
  const benefits = [
    { icon: '\u2714', text: t('claimPageBenefitVerified') },
    { icon: '\u270F', text: t('claimPageBenefitEdit') },
    { icon: '\u2B50', text: t('claimPageBenefitStandout') },
    { icon: '\u26A1', text: t('claimPageBenefitPriority') },
  ]

  return (
    <Box style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
      gap: tokens.spacing[4],
      marginBottom: tokens.spacing[8],
    }}>
      {benefits.map((b, i) => (
        <Box key={i} style={{
          padding: tokens.spacing[5],
          backgroundColor: tokens.colors.bg.secondary,
          borderRadius: tokens.radius.lg,
          border: `1px solid ${tokens.colors.border.primary}`,
          display: 'flex',
          alignItems: 'flex-start',
          gap: tokens.spacing[3],
        }}>
          <span style={{ fontSize: '1.5rem', flexShrink: 0 }}>{b.icon}</span>
          <Text style={{
            fontSize: tokens.typography.fontSize.md,
            color: tokens.colors.text.primary,
            lineHeight: 1.5,
          }}>
            {b.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}
