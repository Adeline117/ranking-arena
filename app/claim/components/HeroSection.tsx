'use client'

import { tokens } from '@/lib/design-tokens'
import { useLanguage } from '@/app/components/Providers/LanguageProvider'
import { Box } from '@/app/components/base'

export function HeroSection() {
  const { t } = useLanguage()
  return (
    <Box style={{
      textAlign: 'center',
      padding: `${tokens.spacing[8]} ${tokens.spacing[4]}`,
      marginBottom: tokens.spacing[6],
    }}>
      <h1 style={{
        fontSize: 'clamp(1.8rem, 4vw, 2.5rem)',
        fontWeight: 800,
        marginBottom: tokens.spacing[3],
        lineHeight: 1.2,
        color: tokens.colors.text.primary,
      }}>
        {t('claimPageTitle')}
      </h1>
      <p style={{
        fontSize: tokens.typography.fontSize.lg,
        color: tokens.colors.text.secondary,
        maxWidth: '600px',
        margin: '0 auto',
        lineHeight: 1.6,
      }}>
        {t('claimPageSubtitle')}
      </p>
    </Box>
  )
}
